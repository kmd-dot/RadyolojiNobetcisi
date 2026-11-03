import React, { useState, useEffect, useMemo } from 'react';
import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  signInWithCustomToken,
  signInAnonymously,
  onAuthStateChanged,
  User
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot
} from 'firebase/firestore';
import {
  PhoneCall,
  MessageSquare,
  Copy,
  Check,
  Users,
  Lock,
  Unlock,
  ArrowLeftRight,
  Plus,
  Trash2,
  Edit3,
  Share2,
  CalendarClock,
  CheckCircle2,
  AlertTriangle,
  Eye,
  Stethoscope,
  KeyRound,
  Upload,
  Sparkles,
  FileText,
  UserCheck,
  Wand2
} from 'lucide-react';

// ============================================================================
// TYPES & GLOBALS
// ============================================================================
declare global {
  interface Window {
    __app_id?: string;
    __firebase_config?: string;
    __initial_auth_token?: string;
  }
}

export interface Doctor {
  id: string;
  name: string;
  phone: string;
}

export interface ShiftState {
  singleDoctorMode: boolean;
  slot1DoctorId: string;
  slot2DoctorId: string;
  manualActiveSlot: number; // 1 or 2
  autoScheduleEnabled: boolean;
  shiftStartTime: string;
  handoverTime: string;
  shiftEndTime: string;
  manualOverrideSlot: number | null;
  manualOverridePeriodKey: string | null;
  adminPin: string;
  lastUpdatedAt: number;
}

export interface ExtractedDoctor {
  id: string;
  norm: string;
  name: string;
  phone: string;
  mentionedOnTodayLine: boolean;
  isFromExistingRoster: boolean;
  orderIndex: number;
}

export interface ExtractionResult {
  extractedDoctors: ExtractedDoctor[];
  suggestedSlot1Id: string | null;
  suggestedSlot2Id: string | null;
  suggestionReason: string;
}

// ============================================================================
// FIREBASE SAFE INITIALIZATION & DUAL-SYNC ENGINE
// ============================================================================
const DEFAULT_DOCTORS: Doctor[] = [
  {
    id: 'doc-1',
    name: 'Dr. Leyla Rostami',
    phone: '+90 532 410 8821'
  },
  {
    id: 'doc-2',
    name: 'Dr. Kerem Alkan',
    phone: '+90 533 692 1405'
  },
  {
    id: 'doc-3',
    name: 'Dr. Selin Demirci',
    phone: '+90 542 318 9044'
  },
  {
    id: 'doc-4',
    name: 'Dr. Caner Özkan',
    phone: '+90 535 811 2390'
  }
];

const DEFAULT_SHIFT_STATE: ShiftState = {
  singleDoctorMode: false,
  slot1DoctorId: 'doc-1',
  slot2DoctorId: 'doc-2',
  manualActiveSlot: 1,
  autoScheduleEnabled: false,
  shiftStartTime: '20:00',
  handoverTime: '02:00',
  shiftEndTime: '08:00',
  manualOverrideSlot: null,
  manualOverridePeriodKey: null,
  adminPin: '1234',
  lastUpdatedAt: Date.now()
};

// Local storage keys for tab sync & offline resilience
const LOCAL_STORAGE_SHIFT_KEY = 'radiology_router_shift_state_v1';
const LOCAL_STORAGE_ROSTER_KEY = 'radiology_router_roster_v1';

// Setup Firebase SDK
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "radyolojinobetcisi.firebaseapp.com",
  projectId: "radyolojinobetcisi",
  storageBucket: "radyolojinobetcisi.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_ID",
  appId: "YOUR_APP_ID"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(app);
const db = getFirestore(app);

// BroadcastChannel for instant cross-tab sync in hospital browser windows
const broadcastChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('radiology_router_channel') : null;

// ============================================================================
// TIME & SCHEDULE HELPER FUNCTIONS
// ============================================================================

function timeToMinutes(timeStr: string): number {
  if (!timeStr || !timeStr.includes(':')) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function isTimeInWindow(currentMin: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return true;
  if (startMin < endMin) {
    return currentMin >= startMin && currentMin < endMin;
  } else {
    return currentMin >= startMin || currentMin < endMin;
  }
}

function evaluateActiveShiftSlot(shiftState: ShiftState, nowDate: Date) {
  if (!shiftState) return { activeSlot: 1, reason: 'manual' };
  if (shiftState.singleDoctorMode) {
    return { activeSlot: 1, reason: 'single' };
  }

  if (!shiftState.autoScheduleEnabled) {
    return {
      activeSlot: shiftState.manualActiveSlot === 2 ? 2 : 1,
      reason: 'manual'
    };
  }

  const currentMin = nowDate.getHours() * 60 + nowDate.getMinutes();
  const startMin = timeToMinutes(shiftState.shiftStartTime || '20:00');
  const handoverMin = timeToMinutes(shiftState.handoverTime || '02:00');
  const endMin = timeToMinutes(shiftState.shiftEndTime || '08:00');

  const inSlot1Window = isTimeInWindow(currentMin, startMin, handoverMin);
  const inSlot2Window = isTimeInWindow(currentMin, handoverMin, endMin);

  let scheduledSlot = shiftState.manualActiveSlot || 1;
  let periodKey = 'outside';

  if (inSlot1Window) {
    scheduledSlot = 1;
    periodKey = `slot1_${shiftState.shiftStartTime}_${shiftState.handoverTime}`;
  } else if (inSlot2Window) {
    scheduledSlot = 2;
    periodKey = `slot2_${shiftState.handoverTime}_${shiftState.shiftEndTime}`;
  }

  if (
    shiftState.manualOverrideSlot &&
    shiftState.manualOverridePeriodKey === periodKey
  ) {
    return {
      activeSlot: shiftState.manualOverrideSlot,
      reason: 'manual_override',
      scheduledSlot,
      periodKey
    };
  }

  return {
    activeSlot: scheduledSlot,
    reason: inSlot1Window || inSlot2Window ? 'schedule' : 'manual_fallback',
    scheduledSlot,
    periodKey
  };
}

function cleanPhoneForTel(phone?: string): string {
  if (!phone) return '';
  return phone.replace(/[^\d+]/g, '');
}

function cleanPhoneForWhatsApp(phone?: string): string {
  if (!phone) return '';
  return phone.replace(/[^\d]/g, '');
}

const TURKISH_MONTHS = [
  'ocak',
  'şubat',
  'mart',
  'nisan',
  'mayıs',
  'haziran',
  'temmuz',
  'ağustos',
  'eylül',
  'ekim',
  'kasım',
  'aralık'
];

function normalizePersonName(nameStr: string): string {
  if (!nameStr) return '';
  return nameStr
    .toLowerCase()
    .replace(/^(uzm\.?\s*dr\.?|asist\.?\s*dr\.?|prof\.?\s*dr\.?|doç\.?\s*dr\.?|dr\.?|doktor)\s+/i, '')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatTurkishPhone(rawPhone: string): string {
  if (!rawPhone) return '';
  const digits = rawPhone.replace(/\D/g, '');
  let core10 = '';
  if (digits.length === 12 && digits.startsWith('905')) {
    core10 = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('05')) {
    core10 = digits.slice(1);
  } else if (digits.length === 10 && digits.startsWith('5')) {
    core10 = digits;
  } else {
    return rawPhone.trim();
  }
  return `+90 ${core10.slice(0, 3)} ${core10.slice(3, 6)} ${core10.slice(6, 8)} ${core10.slice(8, 10)}`;
}

function lineMatchesToday(line: string, nowDate: Date) {
  const lower = line.toLocaleLowerCase('tr-TR');
  if (lower.includes('bugün') || lower.includes('bu gece')) {
    return { matched: true, label: 'Bugün ibaresi' };
  }

  const day = nowDate.getDate();
  const month = nowDate.getMonth() + 1;
  const year = nowDate.getFullYear();
  const dd = String(day).padStart(2, '0');
  const mm = String(month).padStart(2, '0');
  const monthName = TURKISH_MONTHS[month - 1];

  const numericPatterns = [
    `${dd}.${mm}.${year}`,
    `${day}.${mm}.${year}`,
    `${dd}/${mm}/${year}`,
    `${day}/${mm}/${year}`,
    `${dd}-${mm}-${year}`,
    `${dd}.${mm}`,
    `${day}.${month}.`
  ];

  for (const pat of numericPatterns) {
    if (lower.includes(pat)) {
      return { matched: true, label: `${dd}.${mm}.${year}` };
    }
  }

  const textDateRegex = new RegExp(`(^|\\D)0?${day}\\s+${monthName}(\\b|\\s|$)`, 'i');
  if (textDateRegex.test(lower)) {
    return { matched: true, label: `${day} ${monthName.charAt(0).toUpperCase() + monthName.slice(1)}` };
  }

  return { matched: false, label: null };
}

function extractDoctorsAndSuggestOnCall(
  rawText: string,
  existingDoctors: Doctor[] = [],
  nowDate: Date = new Date()
): ExtractionResult {
  if (!rawText || !rawText.trim()) {
    return {
      extractedDoctors: [],
      suggestedSlot1Id: null,
      suggestedSlot2Id: null,
      suggestionReason: ''
    };
  }

  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const phoneRegex = /(?:\+?90[\s\-()]*)?0?[\s\-()]*5\d{2}[\s\-()]*\d{3}[\s\-()]*\d{2}[\s\-()]*\d{2}/g;
  const doctorMap = new Map<string, ExtractedDoctor>();
  let orderCounter = 0;

  const existingByNorm = new Map<string, Doctor>();
  existingDoctors.forEach((doc) => {
    const norm = normalizePersonName(doc.name);
    if (norm) existingByNorm.set(norm, doc);
  });

  const upsertCandidate = (rawName: string, rawPhone: string, isTodayMatch = false) => {
    const cleanedName = rawName
      .replace(/^[\d./\-:\s]+/, '')
      .replace(/\b(pazartesi|salı|çarşamba|perşembe|cuma|cumartesi|pazar|nöbetçi|nöbet|listesi|acil|radyoloji|gece|gündüz|bugün)\b/gi, '')
      .replace(/[()[\]|•*,;]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const norm = normalizePersonName(cleanedName);
    if (!norm || norm.length < 3) return null;
    if (TURKISH_MONTHS.includes(norm)) return null;

    const words = cleanedName
      .replace(/^(uzm\.?\s*dr\.?|asist\.?\s*dr\.?|prof\.?\s*dr\.?|doç\.?\s*dr\.?|dr\.?|doktor)\s+/i, '')
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !/^\d+$/.test(w));

    if (words.length === 0 || words.length > 4) return null;

    const displayWords = words
      .map((w) => w.charAt(0).toLocaleUpperCase('tr-TR') + w.slice(1).toLocaleLowerCase('tr-TR'))
      .join(' ');
    const displayName = `Dr. ${displayWords}`;
    const formattedPhone = rawPhone ? formatTurkishPhone(rawPhone) : '';

    const existingRosterMatch = existingByNorm.get(norm);

    if (doctorMap.has(norm)) {
      const current = doctorMap.get(norm)!;
      if (formattedPhone && (!current.phone || current.phone.includes('0000'))) {
        current.phone = formattedPhone;
      }
      if (isTodayMatch) {
        current.mentionedOnTodayLine = true;
      }
      return current.id;
    } else {
      const id = existingRosterMatch ? existingRosterMatch.id : `extracted-${Date.now()}-${orderCounter}`;
      const phoneToUse = formattedPhone || (existingRosterMatch ? existingRosterMatch.phone : '');

      const entry: ExtractedDoctor = {
        id,
        norm,
        name: existingRosterMatch ? existingRosterMatch.name : displayName,
        phone: phoneToUse,
        mentionedOnTodayLine: isTodayMatch,
        isFromExistingRoster: Boolean(existingRosterMatch),
        orderIndex: orderCounter++
      };
      doctorMap.set(norm, entry);
      return entry.id;
    }
  };

  let todayMatchedIds: string[] = [];
  let matchedDateLabel: string | null = null;

  lines.forEach((line) => {
    const todayCheck = lineMatchesToday(line, nowDate);
    const phonesInLine = line.match(phoneRegex) || [];

    let workingLine = line
      .replace(/^\s*\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\s*[-–—:|]?\s*/i, '')
      .replace(
        new RegExp(`^\\s*\\d{1,2}\\s+(${TURKISH_MONTHS.join('|')})(?:\\s+\\d{4})?\\s*[-–—:|]?\\s*`, 'i'),
        ''
      );

    if (phonesInLine.length > 0) {
      if (phonesInLine.length === 1) {
        const namePart = workingLine.replace(phonesInLine[0], ' ').replace(/[-–—:|,]/g, ' ');
        const id = upsertCandidate(namePart, phonesInLine[0], todayCheck.matched);
        if (todayCheck.matched && id) {
          todayMatchedIds.push(id);
          matchedDateLabel = todayCheck.label;
        }
      } else {
        let remaining = workingLine;
        phonesInLine.forEach((ph) => {
          const idx = remaining.indexOf(ph);
          if (idx !== -1) {
            const beforePhone = remaining.slice(0, idx).replace(/[-–—:|,/&+]/g, ' ');
            const id = upsertCandidate(beforePhone, ph, todayCheck.matched);
            if (todayCheck.matched && id) {
              todayMatchedIds.push(id);
              matchedDateLabel = todayCheck.label;
            }
            remaining = remaining.slice(idx + ph.length);
          }
        });
      }
    } else {
      const segments = workingLine.split(/[/|&,;+]|\s+-\s+|\s+ve\s+/i);
      segments.forEach((seg) => {
        const trimmed = seg.trim();
        const hasDrTitle = /\b(dr\.?|doktor)\b/i.test(trimmed);
        const segNorm = normalizePersonName(trimmed);
        const matchesKnown = existingByNorm.has(segNorm) || doctorMap.has(segNorm);

        if (hasDrTitle || matchesKnown || (todayCheck.matched && trimmed.split(/\s+/).length >= 2)) {
          const id = upsertCandidate(trimmed, '', todayCheck.matched);
          if (todayCheck.matched && id) {
            todayMatchedIds.push(id);
            matchedDateLabel = todayCheck.label;
          }
        }
      });
    }
  });

  const extractedList = Array.from(doctorMap.values()).filter((d) => d.name && d.name.length > 4);
  todayMatchedIds = Array.from(new Set(todayMatchedIds));

  let suggestedSlot1Id: string | null = null;
  let suggestedSlot2Id: string | null = null;
  let suggestionReason = '';

  if (todayMatchedIds.length >= 2) {
    suggestedSlot1Id = todayMatchedIds[0];
    suggestedSlot2Id = todayMatchedIds[1];
    suggestionReason = `Bugünün tarihi (${matchedDateLabel}) satırından otomatik olarak 2 nöbetçi doktor algılandı.`;
  } else if (todayMatchedIds.length === 1) {
    suggestedSlot1Id = todayMatchedIds[0];
    const fallbackSecond = extractedList.find((d) => d.id !== suggestedSlot1Id);
    suggestedSlot2Id = fallbackSecond ? fallbackSecond.id : todayMatchedIds[0];
    suggestionReason = `Bugünün tarihi (${matchedDateLabel}) satırından nöbetçi doktor algılandı.`;
  } else if (extractedList.length >= 2) {
    suggestedSlot1Id = extractedList[0].id;
    suggestedSlot2Id = extractedList[1].id;
    suggestionReason = 'Listedeki ilk 2 doktor varsayılan nöbetçiler olarak otomatik önerildi.';
  } else if (extractedList.length === 1) {
    suggestedSlot1Id = extractedList[0].id;
    suggestedSlot2Id = extractedList[0].id;
    suggestionReason = 'Listeden 1 nöbetçi doktor algılandı.';
  }

  return {
    extractedDoctors: extractedList,
    suggestedSlot1Id,
    suggestedSlot2Id,
    suggestionReason
  };
}

// ============================================================================
// MAIN APPLICATION COMPONENT
// ============================================================================
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Hospital Data State (Loaded from localStorage immediately, synced with Firestore if connected)
  const [doctors, setDoctors] = useState<Doctor[]>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_ROSTER_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {
      console.error('Error reading local roster:', e);
    }
    return DEFAULT_DOCTORS;
  });

  const [shiftState, setShiftState] = useState<ShiftState>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_SHIFT_KEY);
      if (saved) {
        return { ...DEFAULT_SHIFT_STATE, ...JSON.parse(saved) };
      }
    } catch (e) {
      console.error('Error reading local shift state:', e);
    }
    return DEFAULT_SHIFT_STATE;
  });

  // Live Clock State (updates every 10 seconds to trigger automatic handover)
  const [nowDate, setNowDate] = useState(() => new Date());

  // View & Admin Mode State
  const [isAdminUnlocked, setIsAdminUnlocked] = useState(false);
  const [viewMode, setViewMode] = useState<'er_caller' | 'admin_panel'>('er_caller');
  const [adminTab, setAdminTab] = useState<'shift_control' | 'roster' | 'share_security'>('shift_control');

  // PIN Modal State
  const [showPinModal, setShowPinModal] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState('');

  // Doctor Editor & Bulk Import Modals
  const [editingDoctor, setEditingDoctor] = useState<Doctor | null>(null);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkText, setBulkText] = useState('');

  // Smart Extractor State
  const [smartListText, setSmartListText] = useState('');
  const [extractionResult, setExtractionResult] = useState<ExtractionResult | null>(null);
  const [pickedSlot1Id, setPickedSlot1Id] = useState('');
  const [pickedSlot2Id, setPickedSlot2Id] = useState('');
  const [pickedActiveSlot, setPickedActiveSlot] = useState<number>(1);
  const [saveExtractedToRoster, setSaveExtractedToRoster] = useState(true);

  // Admin PIN update draft
  const [newPinInput, setNewPinInput] = useState('');

  // UI Feedback States
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast((prev) => (prev?.message === message ? null : prev));
    }, 3000);
  };

  // 1. Live Clock Effect
  useEffect(() => {
    const interval = setInterval(() => {
      setNowDate(new Date());
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  // 2. Cross-Tab / Window Broadcast Listener (Instant update across tabs without server latency)
  useEffect(() => {
    const handleStorageEvent = (e: StorageEvent) => {
      if (e.key === LOCAL_STORAGE_SHIFT_KEY && e.newValue) {
        try {
          setShiftState(JSON.parse(e.newValue));
        } catch (err) {
          console.error(err);
        }
      } else if (e.key === LOCAL_STORAGE_ROSTER_KEY && e.newValue) {
        try {
          setDoctors(JSON.parse(e.newValue));
        } catch (err) {
          console.error(err);
        }
      }
    };

    window.addEventListener('storage', handleStorageEvent);

    if (broadcastChannel) {
      broadcastChannel.onmessage = (event) => {
        if (event.data?.type === 'SHIFT_UPDATE') {
          setShiftState(event.data.payload);
        } else if (event.data?.type === 'ROSTER_UPDATE') {
          setDoctors(event.data.payload);
        }
      };
    }

    return () => {
      window.removeEventListener('storage', handleStorageEvent);
    };
  }, []);

  // 3. Optional Firebase Authentication & Firestore Listener (If provisioned)
  useEffect(() => {
    let isMounted = true;
    if (!auth || !db) {
      setLoading(false);
      return;
    }

    const initAuth = async () => {
      try {
        if (window.__initial_auth_token) {
          await signInWithCustomToken(auth!, window.__initial_auth_token);
        } else {
          await signInAnonymously(auth!);
        }
      } catch (err) {
        console.error('Firebase Auth warning:', err);
        if (isMounted) setSyncError('Canlı sunucu bağlantısı kurulamadı, yerel modda çalışıyor.');
      }
    };

    initAuth();

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (isMounted) {
        setUser(currentUser);
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!db || !user) return;

    const appId = window.__app_id || 'radiology-oncall-router';
    const shiftDocRef = doc(db, 'artifacts', appId, 'public', 'data', 'radiology_router', 'current_shift');
    const rosterDocRef = doc(db, 'artifacts', appId, 'public', 'data', 'radiology_router', 'department_roster');

    const unsubShift = onSnapshot(
      shiftDocRef,
      async (snapshot) => {
        if (snapshot.exists()) {
          const remoteData = snapshot.data() as ShiftState;
          setShiftState(remoteData);
          localStorage.setItem(LOCAL_STORAGE_SHIFT_KEY, JSON.stringify(remoteData));
        } else {
          try {
            await setDoc(shiftDocRef, DEFAULT_SHIFT_STATE);
          } catch (e) {
            console.error('Error seeding shift state:', e);
          }
        }
        setLoading(false);
      },
      (err) => {
        console.error('Shift snapshot listener:', err);
        setLoading(false);
      }
    );

    const unsubRoster = onSnapshot(
      rosterDocRef,
      async (snapshot) => {
        if (snapshot.exists() && Array.isArray(snapshot.data().doctors)) {
          const remoteDocs = snapshot.data().doctors as Doctor[];
          setDoctors(remoteDocs);
          localStorage.setItem(LOCAL_STORAGE_ROSTER_KEY, JSON.stringify(remoteDocs));
        } else {
          try {
            await setDoc(rosterDocRef, { doctors: DEFAULT_DOCTORS, updatedAt: Date.now() });
          } catch (e) {
            console.error('Error seeding roster:', e);
          }
        }
      },
      (err) => {
        console.error('Roster snapshot listener:', err);
      }
    );

    return () => {
      unsubShift();
      unsubRoster();
    };
  }, [user]);

  // 4. Computed Active Shift Doctor
  const shiftEvaluation = useMemo(() => {
    return evaluateActiveShiftSlot(shiftState, nowDate);
  }, [shiftState, nowDate]);

  const slot1Doctor = useMemo(() => {
    return doctors.find((d) => d.id === shiftState.slot1DoctorId) || doctors[0] || null;
  }, [doctors, shiftState.slot1DoctorId]);

  const slot2Doctor = useMemo(() => {
    return doctors.find((d) => d.id === shiftState.slot2DoctorId) || doctors[1] || doctors[0] || null;
  }, [doctors, shiftState.slot2DoctorId]);

  const activeDoctor =
    shiftEvaluation.activeSlot === 2 && !shiftState.singleDoctorMode ? slot2Doctor : slot1Doctor;

  // 5. State Persistence & Broadcast Handlers
  const saveShiftUpdate = async (partialUpdate: Partial<ShiftState>) => {
    const nextState: ShiftState = {
      ...shiftState,
      ...partialUpdate,
      lastUpdatedAt: Date.now()
    };

    setShiftState(nextState);

    // Save locally & broadcast across browser tabs immediately
    try {
      localStorage.setItem(LOCAL_STORAGE_SHIFT_KEY, JSON.stringify(nextState));
      if (broadcastChannel) {
        broadcastChannel.postMessage({ type: 'SHIFT_UPDATE', payload: nextState });
      }
    } catch (e) {
      console.error('LocalStorage write error:', e);
    }

    // If Firestore connected, sync to remote
    if (db && user) {
      const appId = window.__app_id || 'radiology-oncall-router';
      const shiftDocRef = doc(db, 'artifacts', appId, 'public', 'data', 'radiology_router', 'current_shift');
      try {
        await setDoc(shiftDocRef, nextState);
      } catch (err) {
        console.error('Firestore shift write error:', err);
      }
    }
  };

  const saveRosterUpdate = async (nextDoctors: Doctor[], toastMsg: string | null = 'Doktor listesi güncellendi') => {
    setDoctors(nextDoctors);

    try {
      localStorage.setItem(LOCAL_STORAGE_ROSTER_KEY, JSON.stringify(nextDoctors));
      if (broadcastChannel) {
        broadcastChannel.postMessage({ type: 'ROSTER_UPDATE', payload: nextDoctors });
      }
    } catch (e) {
      console.error('LocalStorage roster write error:', e);
    }

    if (toastMsg) showToast(toastMsg, 'success');

    if (db && user) {
      const appId = window.__app_id || 'radiology-oncall-router';
      const rosterDocRef = doc(db, 'artifacts', appId, 'public', 'data', 'radiology_router', 'department_roster');
      try {
        await setDoc(rosterDocRef, {
          doctors: nextDoctors,
          updatedAt: Date.now()
        });
      } catch (err) {
        console.error('Firestore roster write error:', err);
      }
    }
  };

  // 1-Tap Active Switcher Handler
  const handleSelectActiveSlot = async (targetSlot: number) => {
    const targetDoc = targetSlot === 2 ? slot2Doctor : slot1Doctor;
    const evaluation = evaluateActiveShiftSlot(shiftState, nowDate);

    const updates: Partial<ShiftState> = {
      manualActiveSlot: targetSlot
    };

    if (shiftState.autoScheduleEnabled && evaluation.periodKey) {
      updates.manualOverrideSlot = targetSlot;
      updates.manualOverridePeriodKey = evaluation.periodKey;
    } else {
      updates.manualOverrideSlot = null;
      updates.manualOverridePeriodKey = null;
    }

    await saveShiftUpdate(updates);
    showToast(`Aktif nöbetçi ${targetDoc?.name} olarak değiştirildi`, 'success');
  };

  // Smart List Extractor & Auto-Suggest
  const handleRunSmartExtraction = (inputTextOverride?: string) => {
    const textToParse = typeof inputTextOverride === 'string' ? inputTextOverride : smartListText;
    if (!textToParse || !textToParse.trim()) {
      showToast('Lütfen önce nöbet listesini veya doktor numaralarını yapıştırın.', 'error');
      return;
    }

    const result = extractDoctorsAndSuggestOnCall(textToParse, doctors, nowDate);
    if (result.extractedDoctors.length === 0) {
      showToast('Metinden doktor adı veya telefon numarası çıkarılamadı.', 'error');
      return;
    }

    setExtractionResult(result);
    const defaultSlot1 = result.suggestedSlot1Id || result.extractedDoctors[0]?.id || '';
    const defaultSlot2 =
      result.suggestedSlot2Id ||
      result.extractedDoctors[1]?.id ||
      result.extractedDoctors[0]?.id ||
      '';

    setPickedSlot1Id(defaultSlot1);
    setPickedSlot2Id(defaultSlot2);
    setPickedActiveSlot(1);
    showToast(`${result.extractedDoctors.length} doktor çıkarıldı ve nöbetçi önerisi hazırlandı!`, 'success');
  };

  // Sample Shift List Loader for instant testing
  const handleLoadSampleShiftList = () => {
    const d = nowDate;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();

    const tmrw = new Date(d.getTime() + 86400000);
    const dd2 = String(tmrw.getDate()).padStart(2, '0');
    const mm2 = String(tmrw.getMonth() + 1).padStart(2, '0');

    const sample =
      `RADYOLOJİ NÖBET LİSTESİ VE TELEFONLAR\n` +
      `${dd}.${mm}.${yyyy} (Bugün): Dr. Deniz Aksoy / Dr. Mert Kaya\n` +
      `${dd2}.${mm2}.${yyyy}: Dr. Zeynep Yıldırım / Dr. Burak Demir\n\n` +
      `DOKTOR İLETİŞİM NUMARALARI:\n` +
      `Dr. Deniz Aksoy - 0532 481 92 10\n` +
      `Dr. Mert Kaya - 0533 715 44 82\n` +
      `Dr. Zeynep Yıldırım - +90 542 309 11 65\n` +
      `Dr. Burak Demir - 0535 620 88 34`;

    setSmartListText(sample);
    handleRunSmartExtraction(sample);
  };

  // Apply Smart Extractor Selection
  const handleApplyExtractedSelection = async () => {
    if (!extractionResult || extractionResult.extractedDoctors.length === 0) return;

    const extracted = extractionResult.extractedDoctors;
    const chosenDoc1 = extracted.find((d) => d.id === pickedSlot1Id) || doctors.find((d) => d.id === pickedSlot1Id);
    const chosenDoc2 = extracted.find((d) => d.id === pickedSlot2Id) || doctors.find((d) => d.id === pickedSlot2Id);

    if (!chosenDoc1) {
      showToast('Lütfen 1. nöbetçi doktoru seçin.', 'error');
      return;
    }

    const updatedRoster = [...doctors];
    const ensureInRoster = (candidate?: ExtractedDoctor | Doctor) => {
      if (!candidate) return null;
      const normCandidate = normalizePersonName(candidate.name);
      const existingIdx = updatedRoster.findIndex(
        (r) => r.id === candidate.id || normalizePersonName(r.name) === normCandidate
      );

      if (existingIdx !== -1) {
        if (candidate.phone && candidate.phone.trim()) {
          updatedRoster[existingIdx] = {
            ...updatedRoster[existingIdx],
            phone: candidate.phone
          };
        }
        return updatedRoster[existingIdx].id;
      } else {
        const newEntry: Doctor = {
          id: candidate.id.startsWith('extracted-') ? `doc-${Date.now()}-${Math.floor(Math.random() * 1000)}` : candidate.id,
          name: candidate.name,
          phone: candidate.phone || '+90 500 000 00 00'
        };
        updatedRoster.push(newEntry);
        return newEntry.id;
      }
    };

    if (saveExtractedToRoster) {
      extracted.forEach((item) => ensureInRoster(item));
    }

    const finalSlot1Id = ensureInRoster(chosenDoc1)!;
    const finalSlot2Id = chosenDoc2 ? ensureInRoster(chosenDoc2)! : finalSlot1Id;

    await saveRosterUpdate(updatedRoster, null);

    const evaluation = evaluateActiveShiftSlot(shiftState, nowDate);
    const shiftUpdates: Partial<ShiftState> = {
      slot1DoctorId: finalSlot1Id,
      slot2DoctorId: finalSlot2Id,
      manualActiveSlot: pickedActiveSlot,
      singleDoctorMode: finalSlot1Id === finalSlot2Id
    };

    if (shiftState.autoScheduleEnabled && evaluation.periodKey) {
      shiftUpdates.manualOverrideSlot = pickedActiveSlot;
      shiftUpdates.manualOverridePeriodKey = evaluation.periodKey;
    } else {
      shiftUpdates.manualOverrideSlot = null;
      shiftUpdates.manualOverridePeriodKey = null;
    }

    await saveShiftUpdate(shiftUpdates);

    const activeChosen = pickedActiveSlot === 2 ? chosenDoc2 : chosenDoc1;
    showToast(`Nöbetçiler kaydedildi! Aktif çağrı alan doktor: ${activeChosen?.name}`, 'success');
  };

  // Clipboard Helper with execCommand fallback for seamless webview execution
  const copyToClipboard = (text: string, label = 'Numara kopyalandı!') => {
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopiedPhone(true);
      setTimeout(() => setCopiedPhone(false), 2000);
      showToast(label, 'success');
    } catch (err) {
      console.error('Copy error:', err);
      showToast('Kopyalanamadı.', 'error');
    }
  };

  // Handle Admin PIN Form
  const handlePinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const expectedPin = shiftState.adminPin || '1234';
    if (pinInput.trim() === expectedPin) {
      setIsAdminUnlocked(true);
      setViewMode('admin_panel');
      setShowPinModal(false);
      setPinInput('');
      setPinError('');
      showToast('Yönetici Paneli açıldı', 'success');
    } else {
      setPinError('Hatalı şifre');
    }
  };

  // Bulk Roster Import
  const handleBulkImport = async () => {
    const lines = bulkText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      showToast('Lütfen en az bir satır girin.', 'error');
      return;
    }

    const imported: Doctor[] = [];
    lines.forEach((line, idx) => {
      const parts = line.includes(',')
        ? line.split(',').map((s) => s.trim())
        : line.split('-').map((s) => s.trim());

      const rawName = parts[0] || `Doktor ${idx + 1}`;
      const name = rawName.toLowerCase().startsWith('dr') ? rawName : `Dr. ${rawName}`;
      const phone = parts[1] || '+90 500 000 0000';

      imported.push({
        id: `doc-${Date.now()}-${idx}`,
        name,
        phone
      });
    });

    const nextDoctors = [...doctors, ...imported];
    await saveRosterUpdate(nextDoctors, `${imported.length} doktor listeye eklendi!`);
    setBulkText('');
    setShowBulkModal(false);
  };

  // Add / Edit Single Doctor
  const handleSaveDoctorForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingDoctor || !editingDoctor.name.trim() || !editingDoctor.phone.trim()) {
      showToast('Doktor adı ve telefon numarası zorunludur.', 'error');
      return;
    }

    const formattedName = editingDoctor.name.trim().toLowerCase().startsWith('dr')
      ? editingDoctor.name.trim()
      : `Dr. ${editingDoctor.name.trim()}`;

    const updatedDoc: Doctor = {
      ...editingDoctor,
      name: formattedName,
      phone: editingDoctor.phone.trim()
    };

    const exists = doctors.some((d) => d.id === updatedDoc.id);
    let nextDoctors: Doctor[];
    if (exists) {
      nextDoctors = doctors.map((d) => (d.id === updatedDoc.id ? updatedDoc : d));
    } else {
      nextDoctors = [...doctors, { ...updatedDoc, id: `doc-${Date.now()}` }];
    }

    await saveRosterUpdate(nextDoctors, exists ? 'Doktor bilgileri güncellendi' : 'Doktor listeye eklendi');
    setEditingDoctor(null);
  };

  const handleDeleteDoctor = async (docId: string) => {
    if (doctors.length <= 1) {
      showToast('Listedeki son doktor silinemez.', 'error');
      return;
    }
    const nextDoctors = doctors.filter((d) => d.id !== docId);
    await saveRosterUpdate(nextDoctors, 'Doktor listeden silindi');

    const fallbackId = nextDoctors[0].id;
    const patch: Partial<ShiftState> = {};
    if (shiftState.slot1DoctorId === docId) patch.slot1DoctorId = fallbackId;
    if (shiftState.slot2DoctorId === docId) patch.slot2DoctorId = nextDoctors[1]?.id || fallbackId;
    if (Object.keys(patch).length > 0) {
      await saveShiftUpdate(patch);
    }
  };

  const generateWhatsAppShareMessage = () => {
    const pageUrl = window.location.href;
    const activeName = activeDoctor?.name || 'Nöbetçi Doktor';
    const activePhone = activeDoctor?.phone || '';

    return (
      `🏥 *AKTİF RADYOLOJİ NÖBETÇİSİ*\n\n` +
      `👨‍⚕️ *${activeName}*\n` +
      `📞 *${activePhone}*\n\n` +
      `🔗 Güncel nöbetçi doktor bağlantısı:\n${pageUrl}`
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6">
        <div className="w-14 h-14 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center animate-pulse mb-4">
          <Stethoscope className="w-7 h-7 text-emerald-400" />
        </div>
        <h1 className="text-lg font-bold tracking-tight text-slate-100">Aktif Radyoloji Nöbetçisi</h1>
        <p className="text-xs text-slate-400 mt-1">Yükleniyor...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-slate-950">
      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 w-[92%] max-w-md pointer-events-none">
          <div
            className={`flex items-center gap-3 px-4 py-3.5 rounded-2xl shadow-2xl border backdrop-blur-md transition-all ${
              toast.type === 'error'
                ? 'bg-rose-950/95 border-rose-500/50 text-rose-100'
                : 'bg-slate-900/95 border-emerald-500/50 text-emerald-100'
            }`}
          >
            {toast.type === 'error' ? (
              <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
            ) : (
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            )}
            <span className="text-sm font-medium">{toast.message}</span>
          </div>
        </div>
      )}

      {/* Top Bar */}
      <header className="w-full max-w-xl mx-auto px-4 pt-5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Stethoscope className="w-4 h-4 text-emerald-400 shrink-0" />
          <span className="text-xs sm:text-sm font-bold text-slate-300 tracking-tight">
            Aktif Radyoloji Nöbetçisi
          </span>
        </div>

        {viewMode === 'admin_panel' ? (
          <button
            onClick={() => setViewMode('er_caller')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold bg-emerald-500 text-slate-950 hover:bg-emerald-400 transition-colors shadow-sm cursor-pointer"
          >
            <Eye className="w-4 h-4" />
            <span>Acil Ekranına Dön</span>
          </button>
        ) : (
          <button
            onClick={() => {
              if (isAdminUnlocked) {
                setViewMode('admin_panel');
              } else {
                setShowPinModal(true);
              }
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-slate-900/80 border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700 transition-all cursor-pointer"
          >
            {isAdminUnlocked ? (
              <>
                <Unlock className="w-3.5 h-3.5 text-indigo-400" />
                <span>Yönetici Girişi</span>
              </>
            ) : (
              <>
                <Lock className="w-3.5 h-3.5 text-slate-500" />
                <span>Yönetici Girişi</span>
              </>
            )}
          </button>
        )}
      </header>

      {syncError && (
        <div className="max-w-xl mx-auto mt-2 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-2 text-center text-xs text-amber-300">
          {syncError}
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col justify-center max-w-xl w-full mx-auto px-4 py-6">
        {viewMode === 'er_caller' ? (
          /* PUBLIC ER CALLER VIEW */
          <div className="w-full">
            <div className="rounded-3xl bg-slate-900 border-2 border-emerald-500/60 shadow-2xl shadow-emerald-950/30 overflow-hidden p-6 sm:p-8 text-center space-y-6">
              {/* Badge */}
              <div className="inline-flex items-center justify-center gap-2.5 px-4 py-2 rounded-full bg-emerald-500/15 border border-emerald-500/30">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500" />
                </span>
                <span className="text-xs sm:text-sm font-extrabold tracking-wider uppercase text-emerald-300">
                  Aktif Radyoloji Nöbetçisi
                </span>
              </div>

              {/* Doctor Name */}
              <div>
                <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
                  {activeDoctor?.name || 'Dr. —'}
                </h1>
              </div>

              {/* Phone & Copy Button */}
              <div className="bg-slate-950 border border-slate-800 rounded-2xl p-5 space-y-4">
                <a
                  href={`tel:${cleanPhoneForTel(activeDoctor?.phone)}`}
                  className="block text-2xl sm:text-4xl font-mono font-extrabold text-emerald-400 tracking-wider hover:underline"
                >
                  {activeDoctor?.phone || '—'}
                </a>

                <button
                  onClick={() =>
                    copyToClipboard(
                      activeDoctor?.phone || '',
                      'Telefon numarası kopyalandı!'
                    )
                  }
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs sm:text-sm font-semibold border border-slate-700 transition-colors cursor-pointer"
                >
                  {copiedPhone ? (
                    <>
                      <Check className="w-4 h-4 text-emerald-400" />
                      <span>Numara Kopyalandı</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 text-emerald-400" />
                      <span>Numarayı Kopyala</span>
                    </>
                  )}
                </button>
              </div>

              {/* Call & WhatsApp Action Buttons */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 pt-1">
                <a
                  href={`tel:${cleanPhoneForTel(activeDoctor?.phone)}`}
                  className="flex items-center justify-center gap-3 w-full py-4 px-6 rounded-2xl bg-emerald-500 hover:bg-emerald-400 active:scale-[0.99] text-slate-950 font-extrabold text-base sm:text-lg shadow-lg shadow-emerald-500/20 transition-all cursor-pointer"
                >
                  <PhoneCall className="w-5 h-5 stroke-[2.5]" />
                  <span>Doktoru Hemen Ara</span>
                </a>

                <a
                  href={`https://wa.me/${cleanPhoneForWhatsApp(activeDoctor?.phone)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-3 w-full py-4 px-6 rounded-2xl bg-teal-600/25 hover:bg-teal-600/35 border border-teal-500/40 text-teal-200 font-bold text-base sm:text-lg transition-all cursor-pointer"
                >
                  <MessageSquare className="w-5 h-5 text-teal-400" />
                  <span>WhatsApp Doktor</span>
                </a>
              </div>
            </div>
          </div>
        ) : (
          /* ADMIN CONTROL PANEL VIEW */
          <div className="space-y-5">
            {/* Admin Header Banner */}
            <div className="rounded-2xl bg-slate-900 border border-indigo-500/40 p-4 sm:p-5 flex items-center justify-between gap-3">
              <div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-400 block">
                  Yönetici Paneli
                </span>
                <h2 className="text-lg sm:text-xl font-bold text-white mt-0.5">
                  Şu An Aramaları Alan Aktif Nöbetçi:{' '}
                  <span className="text-emerald-400">{activeDoctor?.name}</span>
                </h2>
              </div>

              <button
                onClick={() => {
                  setIsAdminUnlocked(false);
                  setViewMode('er_caller');
                  showToast('Yönetici oturumu kapatıldı', 'success');
                }}
                className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 shrink-0 border border-slate-700 cursor-pointer"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Çıkış Yap</span>
              </button>
            </div>

            {/* Admin Tabs */}
            <div className="grid grid-cols-3 gap-2 bg-slate-900 p-1.5 rounded-2xl border border-slate-800">
              <button
                onClick={() => setAdminTab('shift_control')}
                className={`py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                  adminTab === 'shift_control'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <ArrowLeftRight className="w-4 h-4 shrink-0" />
                <span>Nöbet Seçimi</span>
              </button>

              <button
                onClick={() => setAdminTab('roster')}
                className={`py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                  adminTab === 'roster'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Users className="w-4 h-4 shrink-0" />
                <span>Doktor Listesi ({doctors.length})</span>
              </button>

              <button
                onClick={() => setAdminTab('share_security')}
                className={`py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                  adminTab === 'share_security'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Share2 className="w-4 h-4 shrink-0" />
                <span>Paylaş &amp; Şifre</span>
              </button>
            </div>

            {/* ADMIN TAB 1: SHIFT SELECTION & SMART EXTRACTOR */}
            {adminTab === 'shift_control' && (
              <div className="space-y-5">
                {/* Smart List Extractor & Auto-Suggester Card */}
                <div className="rounded-3xl bg-gradient-to-br from-indigo-950/50 via-slate-900 to-slate-900 border border-indigo-500/40 p-5 space-y-4 shadow-xl">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-2xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center shrink-0 mt-0.5">
                        <Sparkles className="w-5 h-5 text-indigo-400" />
                      </div>
                      <div>
                        <h3 className="text-base font-bold text-white flex items-center gap-2">
                          <span>Listeden Otomatik Çıkar ve Nöbetçi Öner</span>
                        </h3>
                        <p className="text-xs text-slate-300 mt-0.5">
                          WhatsApp mesajını, nöbet çizelgesini veya doktor telefon listesini aşağıya yapıştırın. Program isim ve telefonları otomatik ayıklar, bugünün 2 nöbetçisini önerir; siz de nöbetteki 2 kişiyi ve aktif aranacak doktoru seçersiniz.
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={handleLoadSampleShiftList}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-400/40 text-indigo-200 text-xs font-semibold transition-all shrink-0 cursor-pointer"
                    >
                      <FileText className="w-3.5 h-3.5 text-indigo-300" />
                      <span>Örnek Nöbet Listesi Yükle</span>
                    </button>
                  </div>

                  <div className="space-y-2.5">
                    <textarea
                      rows={4}
                      value={smartListText}
                      onChange={(e) => setSmartListText(e.target.value)}
                      placeholder={`Örnek yapıştırma formatları:\n03.11.2026: Dr. Leyla Rostami (0532 410 88 21) - Dr. Kerem Alkan (0533 692 14 05)\nveya nöbet tablosu + alt kısımda doktor telefon numaraları...`}
                      className="w-full rounded-2xl bg-slate-950/90 border border-slate-700/80 focus:border-indigo-400 p-3.5 text-xs sm:text-sm font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none"
                    />

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={saveExtractedToRoster}
                          onChange={(e) => setSaveExtractedToRoster(e.target.checked)}
                          className="rounded border-slate-700 text-indigo-500 focus:ring-0"
                        />
                        <span>Çıkarılan doktorları ve numaraları kalıcı listeye de kaydet</span>
                      </label>

                      <div className="flex items-center gap-2">
                        {smartListText && (
                          <button
                            type="button"
                            onClick={() => {
                              setSmartListText('');
                              setExtractionResult(null);
                            }}
                            className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium cursor-pointer"
                          >
                            Temizle
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleRunSmartExtraction()}
                          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs sm:text-sm shadow-lg shadow-indigo-600/25 transition-all cursor-pointer"
                        >
                          <Wand2 className="w-4 h-4" />
                          <span>Doktorları Çıkar ve Nöbetçi Öner</span>
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* 3-Step Interactive Confirmation */}
                  {extractionResult && extractionResult.extractedDoctors.length > 0 && (
                    <div className="rounded-2xl bg-slate-950/90 border border-indigo-500/40 p-4 space-y-4 mt-2">
                      {/* Step 1 */}
                      <div className="space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-extrabold uppercase tracking-wider text-indigo-300">
                            1. Adım: Çıkarılan Doktorlar ({extractionResult.extractedDoctors.length}) ve Otomatik Öneri
                          </span>
                          {extractionResult.suggestionReason && (
                            <span className="text-[11px] font-medium text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded-full">
                              ✨ {extractionResult.suggestionReason}
                            </span>
                          )}
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {extractionResult.extractedDoctors.map((docItem) => {
                            const isAutoSuggested =
                              docItem.id === extractionResult.suggestedSlot1Id ||
                              docItem.id === extractionResult.suggestedSlot2Id;
                            const isPicked1 = pickedSlot1Id === docItem.id;
                            const isPicked2 = pickedSlot2Id === docItem.id;

                            return (
                              <div
                                key={docItem.id}
                                className={`rounded-xl p-3 border flex items-center justify-between gap-2 transition-all ${
                                  isPicked1 || isPicked2
                                    ? 'bg-indigo-950/50 border-indigo-400/60'
                                    : 'bg-slate-900/90 border-slate-800'
                                }`}
                              >
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="text-xs sm:text-sm font-bold text-white truncate">
                                      {docItem.name}
                                    </span>
                                    {isAutoSuggested && (
                                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                        Bugün İçin Önerilen
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs font-mono text-emerald-400 mt-0.5">
                                    {docItem.phone || 'Numara belirtilmedi'}
                                  </p>
                                </div>

                                <div className="flex items-center gap-1 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => setPickedSlot1Id(docItem.id)}
                                    className={`px-2 py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                                      isPicked1
                                        ? 'bg-emerald-500 text-slate-950'
                                        : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                                    }`}
                                  >
                                    1. Nöbetçi
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setPickedSlot2Id(docItem.id)}
                                    className={`px-2 py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                                      isPicked2
                                        ? 'bg-indigo-500 text-white'
                                        : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                                    }`}
                                  >
                                    2. Nöbetçi
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* Step 2 */}
                      <div className="space-y-2.5 pt-3 border-t border-slate-800">
                        <span className="text-xs font-extrabold uppercase tracking-wider text-indigo-300 block">
                          2. Adım: Nöbetteki 2 Doktoru Onaylayın veya Değiştirin
                        </span>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="bg-slate-900 p-3 rounded-xl border border-slate-800 space-y-1.5">
                            <label className="text-[11px] font-bold text-slate-400 block">
                              1. Nöbetçi Doktor (Önerilen)
                            </label>
                            <select
                              value={pickedSlot1Id}
                              onChange={(e) => setPickedSlot1Id(e.target.value)}
                              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-xs sm:text-sm font-bold text-white"
                            >
                              {extractionResult.extractedDoctors.map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.name} ({d.phone || 'Numarasız'})
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="bg-slate-900 p-3 rounded-xl border border-slate-800 space-y-1.5">
                            <label className="text-[11px] font-bold text-slate-400 block">
                              2. Nöbetçi Doktor (Önerilen)
                            </label>
                            <select
                              value={pickedSlot2Id}
                              onChange={(e) => setPickedSlot2Id(e.target.value)}
                              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-xs sm:text-sm font-bold text-white"
                            >
                              {extractionResult.extractedDoctors.map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.name} ({d.phone || 'Numarasız'})
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                      </div>

                      {/* Step 3 */}
                      <div className="space-y-3 pt-3 border-t border-slate-800">
                        <span className="text-xs font-extrabold uppercase tracking-wider text-emerald-400 block">
                          3. Adım: Şu An Aktif Çağrı Alacak Doktoru Seçin
                        </span>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {[
                            {
                              slot: 1,
                              doc:
                                extractionResult.extractedDoctors.find(
                                  (d) => d.id === pickedSlot1Id
                                ) || extractionResult.extractedDoctors[0]
                            },
                            {
                              slot: 2,
                              doc:
                                extractionResult.extractedDoctors.find(
                                  (d) => d.id === pickedSlot2Id
                                ) || extractionResult.extractedDoctors[0]
                            }
                          ].map(({ slot, doc }) => {
                            const isSelectedActive = pickedActiveSlot === slot;
                            return (
                              <button
                                key={slot}
                                type="button"
                                onClick={() => setPickedActiveSlot(slot)}
                                className={`p-3.5 rounded-xl border-2 text-left flex items-center justify-between gap-3 transition-all cursor-pointer ${
                                  isSelectedActive
                                    ? 'bg-emerald-950/40 border-emerald-500 text-white'
                                    : 'bg-slate-900/70 border-slate-800 text-slate-300 hover:border-slate-700'
                                }`}
                              >
                                <div>
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">
                                    {slot}. Nöbetçi Doktor
                                  </span>
                                  <span className="text-sm font-extrabold text-white block mt-0.5">
                                    {doc?.name || '—'}
                                  </span>
                                  <span className="text-xs font-mono text-emerald-400">
                                    {doc?.phone || ''}
                                  </span>
                                </div>

                                <div
                                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold shrink-0 ${
                                    isSelectedActive
                                      ? 'bg-emerald-500 text-slate-950'
                                      : 'bg-slate-800 text-slate-400'
                                  }`}
                                >
                                  {isSelectedActive ? 'Aktif Çağrı Alan' : 'Bu Doktoru Seç'}
                                </div>
                              </button>
                            );
                          })}
                        </div>

                        <button
                          type="button"
                          onClick={handleApplyExtractedSelection}
                          className="w-full py-3.5 px-5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 transition-all cursor-pointer"
                        >
                          <UserCheck className="w-5 h-5 stroke-[2.5]" />
                          <span>Nöbetçileri Onayla ve Seçilen Doktoru Acil Ekranında Göster</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* 2 Doctors on Duty & 1-Tap Switcher */}
                <div className="rounded-3xl bg-slate-900 border border-slate-800 p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-base font-bold text-white">
                        Nöbetçi Doktorlar ve Aktif Kişi Seçimi
                      </h3>
                      <p className="text-xs text-slate-400">
                        Nöbetteki 2 doktoru seçin ve acilin kimi arayacağını tek dokunuşla belirleyin.
                      </p>
                    </div>

                    <label className="inline-flex items-center gap-2 text-xs text-slate-300 bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-800 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={shiftState.singleDoctorMode}
                        onChange={(e) =>
                          saveShiftUpdate({ singleDoctorMode: e.target.checked })
                        }
                        className="rounded border-slate-700 text-indigo-500 focus:ring-0"
                      />
                      <span>Tek Nöbetçi Modu</span>
                    </label>
                  </div>

                  <div
                    className={`grid grid-cols-1 ${
                      shiftState.singleDoctorMode ? '' : 'sm:grid-cols-2'
                    } gap-4`}
                  >
                    {/* Slot 1 Doctor */}
                    <div
                      className={`rounded-2xl p-4 border-2 transition-all flex flex-col justify-between gap-4 ${
                        shiftEvaluation.activeSlot === 1
                          ? 'bg-emerald-950/25 border-emerald-500'
                          : 'bg-slate-950/60 border-slate-800'
                      }`}
                    >
                      <div className="space-y-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-bold uppercase text-slate-400">
                            1. Nöbetçi Doktor
                          </span>
                          {shiftEvaluation.activeSlot === 1 && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500 text-slate-950">
                              <Check className="w-3 h-3 stroke-[3]" />
                              EKRANDA AKTİF
                            </span>
                          )}
                        </div>

                        <select
                          value={shiftState.slot1DoctorId}
                          onChange={(e) =>
                            saveShiftUpdate({ slot1DoctorId: e.target.value })
                          }
                          className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2.5 text-sm font-bold text-white focus:outline-none focus:border-emerald-500 cursor-pointer"
                        >
                          {doctors.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name} ({d.phone})
                            </option>
                          ))}
                        </select>

                        <p className="text-xs font-mono text-slate-300">
                          {slot1Doctor?.phone}
                        </p>
                      </div>

                      {!shiftState.singleDoctorMode && (
                        <button
                          onClick={() => handleSelectActiveSlot(1)}
                          disabled={shiftEvaluation.activeSlot === 1}
                          className={`w-full py-3 px-4 rounded-xl font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all ${
                            shiftEvaluation.activeSlot === 1
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 cursor-default'
                              : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-md cursor-pointer'
                          }`}
                        >
                          {shiftEvaluation.activeSlot === 1 ? (
                            <>
                              <CheckCircle2 className="w-4 h-4" />
                              <span>Şu Anda Gösteriliyor</span>
                            </>
                          ) : (
                            <>
                              <PhoneCall className="w-4 h-4" />
                              <span>Acil Ekranında Göster</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>

                    {/* Slot 2 Doctor */}
                    {!shiftState.singleDoctorMode && (
                      <div
                        className={`rounded-2xl p-4 border-2 transition-all flex flex-col justify-between gap-4 ${
                          shiftEvaluation.activeSlot === 2
                            ? 'bg-emerald-950/25 border-emerald-500'
                            : 'bg-slate-950/60 border-slate-800'
                        }`}
                      >
                        <div className="space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold uppercase text-slate-400">
                              2. Nöbetçi Doktor
                            </span>
                            {shiftEvaluation.activeSlot === 2 && (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500 text-slate-950">
                                <Check className="w-3 h-3 stroke-[3]" />
                                EKRANDA AKTİF
                              </span>
                            )}
                          </div>

                          <select
                            value={shiftState.slot2DoctorId}
                            onChange={(e) =>
                              saveShiftUpdate({ slot2DoctorId: e.target.value })
                            }
                            className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2.5 text-sm font-bold text-white focus:outline-none focus:border-emerald-500 cursor-pointer"
                          >
                            {doctors.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.name} ({d.phone})
                              </option>
                            ))}
                          </select>

                          <p className="text-xs font-mono text-slate-300">
                            {slot2Doctor?.phone}
                          </p>
                        </div>

                        <button
                          onClick={() => handleSelectActiveSlot(2)}
                          disabled={shiftEvaluation.activeSlot === 2}
                          className={`w-full py-3 px-4 rounded-xl font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all ${
                            shiftEvaluation.activeSlot === 2
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 cursor-default'
                              : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-md cursor-pointer'
                          }`}
                        >
                          {shiftEvaluation.activeSlot === 2 ? (
                            <>
                              <CheckCircle2 className="w-4 h-4" />
                              <span>Şu Anda Gösteriliyor</span>
                            </>
                          ) : (
                            <>
                              <PhoneCall className="w-4 h-4" />
                              <span>Acil Ekranında Göster</span>
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Background Auto Handover Settings */}
                {!shiftState.singleDoctorMode && (
                  <div className="rounded-3xl bg-slate-900 border border-slate-800 p-5 space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <CalendarClock className="w-5 h-5 text-indigo-400 shrink-0" />
                        <div>
                          <h3 className="text-sm sm:text-base font-bold text-white">
                            Otomatik Nöbet Değişim Saati (İsteğe Bağlı)
                          </h3>
                          <p className="text-xs text-slate-400">
                            Belirlediğiniz saatte ekran otomatik olarak 2. doktora geçer (Acil ekranında saat bilgisi görünmez).
                          </p>
                        </div>
                      </div>

                      <button
                        onClick={() =>
                          saveShiftUpdate({
                            autoScheduleEnabled: !shiftState.autoScheduleEnabled,
                            manualOverrideSlot: null,
                            manualOverridePeriodKey: null
                          })
                        }
                        className={`px-3.5 py-2 rounded-xl font-bold text-xs border transition-all shrink-0 cursor-pointer ${
                          shiftState.autoScheduleEnabled
                            ? 'bg-indigo-600 border-indigo-400 text-white'
                            : 'bg-slate-800 border-slate-700 text-slate-400'
                        }`}
                      >
                        {shiftState.autoScheduleEnabled ? 'Açık' : 'Kapalı'}
                      </button>
                    </div>

                    {shiftState.autoScheduleEnabled && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-3 border-t border-slate-800">
                        <div className="bg-slate-950 p-3 rounded-2xl border border-slate-800">
                          <label className="text-[11px] font-bold text-slate-400 block">
                            1. Doktor Başlangıç
                          </label>
                          <input
                            type="time"
                            value={shiftState.shiftStartTime}
                            onChange={(e) =>
                              saveShiftUpdate({
                                shiftStartTime: e.target.value,
                                manualOverrideSlot: null
                              })
                            }
                            className="mt-1 w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm font-mono font-bold text-white"
                          />
                        </div>

                        <div className="bg-indigo-950/40 p-3 rounded-2xl border border-indigo-500/40">
                          <label className="text-[11px] font-bold text-indigo-300 block">
                            2. Doktora Geçiş Saati
                          </label>
                          <input
                            type="time"
                            value={shiftState.handoverTime}
                            onChange={(e) =>
                              saveShiftUpdate({
                                handoverTime: e.target.value,
                                manualOverrideSlot: null
                              })
                            }
                            className="mt-1 w-full bg-slate-900 border border-indigo-500/50 rounded-xl px-3 py-2 text-sm font-mono font-bold text-emerald-400"
                          />
                        </div>

                        <div className="bg-slate-950 p-3 rounded-2xl border border-slate-800">
                          <label className="text-[11px] font-bold text-slate-400 block">
                            Nöbet Bitiş Saati
                          </label>
                          <input
                            type="time"
                            value={shiftState.shiftEndTime}
                            onChange={(e) =>
                              saveShiftUpdate({
                                shiftEndTime: e.target.value,
                                manualOverrideSlot: null
                              })
                            }
                            className="mt-1 w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm font-mono font-bold text-white"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Admin Password Change Card */}
                <div className="rounded-3xl bg-slate-900 border border-slate-800 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <h3 className="text-sm sm:text-base font-bold text-white flex items-center gap-2">
                      <KeyRound className="w-4 h-4 text-indigo-400" />
                      <span>Yönetici Şifresini Değiştir</span>
                    </h3>
                    <p className="text-xs text-slate-400">
                      Yönetici girişi şifresini buradan istediğiniz zaman güncelleyebilirsiniz.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value={newPinInput}
                      onChange={(e) => setNewPinInput(e.target.value)}
                      placeholder="Yeni şifre girin"
                      maxLength={16}
                      className="w-full sm:w-44 rounded-xl bg-slate-950 border border-slate-700 px-3.5 py-2.5 text-xs sm:text-sm font-mono text-white focus:outline-none focus:border-indigo-500"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (!newPinInput.trim()) return;
                        saveShiftUpdate({ adminPin: newPinInput.trim() });
                        setNewPinInput('');
                        showToast('Yönetici şifresi güncellendi!', 'success');
                      }}
                      className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shrink-0 transition-colors cursor-pointer"
                    >
                      Şifreyi Değiştir
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ADMIN TAB 2: DOCTOR ROSTER */}
            {adminTab === 'roster' && (
              <div className="rounded-3xl bg-slate-900 border border-slate-800 p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-bold text-white">
                      Radyoloji Doktor Listesi ({doctors.length})
                    </h3>
                    <p className="text-xs text-slate-400">
                      Doktor isimlerini ve telefon numaralarını ekleyin veya düzenleyin.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowBulkModal(true)}
                      className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 border border-slate-700 cursor-pointer"
                    >
                      <Upload className="w-3.5 h-3.5 text-indigo-400" />
                      <span>Toplu Ekle</span>
                    </button>
                    <button
                      onClick={() =>
                        setEditingDoctor({
                          id: '',
                          name: 'Dr. ',
                          phone: '+90 5'
                        })
                      }
                      className="px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                    >
                      <Plus className="w-4 h-4 stroke-[2.5]" />
                      <span>Doktor Ekle</span>
                    </button>
                  </div>
                </div>

                {/* Single Doctor Editor Form */}
                {editingDoctor && (
                  <form
                    onSubmit={handleSaveDoctorForm}
                    className="rounded-2xl bg-slate-950 border border-indigo-500/50 p-4 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold uppercase text-indigo-300">
                        {editingDoctor.id ? 'Doktoru Düzenle' : 'Yeni Doktor Ekle'}
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditingDoctor(null)}
                        className="text-xs text-slate-400 hover:text-white cursor-pointer"
                      >
                        İptal
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">
                          Doktor Adı Soyadı *
                        </label>
                        <input
                          type="text"
                          required
                          value={editingDoctor.name}
                          onChange={(e) =>
                            setEditingDoctor({ ...editingDoctor, name: e.target.value })
                          }
                          placeholder="Örn: Dr. Ahmet Yılmaz"
                          className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">
                          Telefon Numarası *
                        </label>
                        <input
                          type="text"
                          required
                          value={editingDoctor.phone}
                          onChange={(e) =>
                            setEditingDoctor({ ...editingDoctor, phone: e.target.value })
                          }
                          placeholder="Örn: +90 532 555 0101"
                          className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-sm font-mono text-white"
                        />
                      </div>
                    </div>

                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => setEditingDoctor(null)}
                        className="px-3.5 py-2 rounded-xl bg-slate-800 text-xs text-slate-300 cursor-pointer"
                      >
                        İptal
                      </button>
                      <button
                        type="submit"
                        className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-bold text-white cursor-pointer"
                      >
                        Kaydet
                      </button>
                    </div>
                  </form>
                )}

                {/* Doctor List */}
                <div className="divide-y divide-slate-800/80">
                  {doctors.map((docItem) => {
                    const isSlot1 = shiftState.slot1DoctorId === docItem.id;
                    const isSlot2 =
                      !shiftState.singleDoctorMode && shiftState.slot2DoctorId === docItem.id;
                    return (
                      <div
                        key={docItem.id}
                        className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-white text-sm">
                              {docItem.name}
                            </span>
                            {isSlot1 && (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300">
                                1. Nöbetçi
                              </span>
                            )}
                            {isSlot2 && (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-300">
                                2. Nöbetçi
                              </span>
                            )}
                          </div>
                          <p className="text-xs font-mono text-slate-400">{docItem.phone}</p>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() =>
                              saveShiftUpdate({ slot1DoctorId: docItem.id })
                            }
                            className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer"
                          >
                            1. Seç
                          </button>
                          {!shiftState.singleDoctorMode && (
                            <button
                              onClick={() =>
                                saveShiftUpdate({ slot2DoctorId: docItem.id })
                              }
                              className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer"
                            >
                              2. Seç
                            </button>
                          )}
                          <button
                            onClick={() => setEditingDoctor(docItem)}
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer"
                            title="Düzenle"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteDoctor(docItem.id)}
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-400 cursor-pointer"
                            title="Sil"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ADMIN TAB 3: SHARE & SECURITY */}
            {adminTab === 'share_security' && (
              <div className="space-y-4">
                <div className="rounded-3xl bg-slate-900 border border-slate-800 p-5 space-y-4">
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <Share2 className="w-4 h-4 text-emerald-400" />
                    <span>WhatsApp Grubunda Paylaş</span>
                  </h3>
                  <p className="text-xs text-slate-400">
                    Acil servis veya hastane WhatsApp grubuna bağlantıyı göndermek için aşağıdaki butonları kullanabilirsiniz.
                  </p>

                  <div className="flex flex-wrap gap-2.5">
                    <button
                      onClick={() => {
                        const msg = generateWhatsAppShareMessage();
                        window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
                      }}
                      className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-2 cursor-pointer"
                    >
                      <MessageSquare className="w-4 h-4" />
                      <span>WhatsApp ile Gönder</span>
                    </button>

                    <button
                      onClick={() =>
                        copyToClipboard(
                          window.location.href,
                          'Sayfa bağlantısı kopyalandı!'
                        )
                      }
                      className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs flex items-center gap-2 border border-slate-700 cursor-pointer"
                    >
                      <Copy className="w-4 h-4 text-emerald-400" />
                      <span>Bağlantıyı Kopyala</span>
                    </button>
                  </div>
                </div>

                <div className="rounded-3xl bg-slate-900 border border-slate-800 p-5 space-y-3">
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-indigo-400" />
                    <span>Yönetici Şifresini Değiştir</span>
                  </h3>
                  <p className="text-xs text-slate-400">
                    Yönetici girişi için kullanılan şifreyi buradan istediğiniz zaman güncelleyebilirsiniz.
                  </p>
                  <div className="flex items-center gap-2 max-w-xs">
                    <input
                      type="password"
                      value={newPinInput}
                      onChange={(e) => setNewPinInput(e.target.value)}
                      placeholder="Yeni Şifre Girin"
                      maxLength={16}
                      className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-indigo-500"
                    />
                    <button
                      onClick={() => {
                        if (!newPinInput.trim()) return;
                        saveShiftUpdate({ adminPin: newPinInput.trim() });
                        setNewPinInput('');
                        showToast('Yönetici şifresi güncellendi!', 'success');
                      }}
                      className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shrink-0 cursor-pointer"
                    >
                      Şifreyi Güncelle
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* MODAL 1: ADMIN PIN LOGIN MODAL */}
      {showPinModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center">
                <Lock className="w-4 h-4 text-indigo-400" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Yönetici Girişi</h3>
                <p className="text-xs text-slate-400">Devam etmek için şifrenizi girin</p>
              </div>
            </div>

            <form onSubmit={handlePinSubmit} className="space-y-3">
              <div>
                <input
                  type="password"
                  autoFocus
                  value={pinInput}
                  onChange={(e) => {
                    setPinInput(e.target.value);
                    setPinError('');
                  }}
                  placeholder="Şifrenizi girin"
                  className="w-full text-center text-lg font-mono font-bold rounded-2xl bg-slate-950 border border-slate-700 py-3.5 px-4 text-white placeholder:text-slate-500 placeholder:font-sans placeholder:text-sm placeholder:tracking-normal focus:outline-none focus:border-indigo-500"
                />
              </div>

              {pinError && <p className="text-xs text-rose-400 text-center font-medium">{pinError}</p>}

              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setShowPinModal(false);
                    setPinInput('');
                    setPinError('');
                  }}
                  className="w-full py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-sm transition-colors cursor-pointer"
                >
                  İptal
                </button>
                <button
                  type="submit"
                  className="w-full py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm shadow-lg transition-colors cursor-pointer"
                >
                  Giriş Yap
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: BULK ROSTER IMPORT MODAL */}
      {showBulkModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-lg w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white">Toplu Doktor Listesi Ekle</h3>
              <button
                onClick={() => setShowBulkModal(false)}
                className="text-xs text-slate-400 hover:text-white cursor-pointer"
              >
                Kapat
              </button>
            </div>
            <p className="text-xs text-slate-400">
              Her satıra bir doktor gelecek şekilde <code className="text-indigo-300">Dr. İsim Soyisim, Telefon</code> formatında yapıştırın:
            </p>
            <textarea
              rows={6}
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={`Dr. Deniz Aksoy, +90 532 111 2233\nDr. Mert Kaya, +90 533 444 5566`}
              className="w-full rounded-2xl bg-slate-950 border border-slate-700 p-3.5 text-xs font-mono text-white"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowBulkModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 text-xs text-slate-300 cursor-pointer"
              >
                İptal
              </button>
              <button
                onClick={handleBulkImport}
                className="px-4 py-2 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs cursor-pointer"
              >
                Listeye Ekle
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
