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
  Building2,
  Clock,
  Palmtree,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  RotateCcw
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

export interface DailyScheduleEntry {
  slot1Id: string;
  slot2Id: string;
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
  manualDoctorOverrideShiftKey?: string | null; // Prevents monthly table from overwriting manual swap
  adminPin: string;
  lastUpdatedAt: number;
  ext1Label?: string;
  ext1Number?: string;
  ext2Label?: string;
  ext2Number?: string;
  ext3Label?: string;
  ext3Number?: string;
  workHoursModeEnabled?: boolean;
  holidayOverrideDateKey?: string | null;
  monthlySchedule?: Record<string, DailyScheduleEntry>; // Key: "YYYY-MM-DD"
}

// ============================================================================
// FIREBASE CONFIG & INITIALIZATION
// ============================================================================
const firebaseConfig = {
  apiKey: "AIzaSyByXQ_6GeH-efIRcIhZd10rrzrCXhoCqi0",
  authDomain: "radyolojinobetcisi.firebaseapp.com",
  projectId: "radyolojinobetcisi",
  storageBucket: "radyolojinobetcisi.firebasestorage.app",
  messagingSenderId: "883771809864",
  appId: "1:883771809864:web:622c0cbdbea9729700387d"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(app);
const db = getFirestore(app);

const broadcastChannel =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('radiology_router_channel')
    : null;

// ============================================================================
// DEFAULTS & STORAGE KEYS
// ============================================================================
const DEFAULT_DOCTORS: Doctor[] = [
  { id: 'doc-1', name: 'Dr. Halit Muhittin', phone: '+90 532 000 0000' },
  { id: 'doc-2', name: 'Dr. Kerem Alkan', phone: '+90 533 692 1405' },
  { id: 'doc-3', name: 'Dr. Selin Demirci', phone: '+90 542 318 9044' },
  { id: 'doc-4', name: 'Dr. Caner Özkan', phone: '+90 535 811 2390' }
];

const DEFAULT_SHIFT_STATE: ShiftState = {
  singleDoctorMode: false,
  slot1DoctorId: 'doc-1',
  slot2DoctorId: 'doc-2',
  manualActiveSlot: 1,
  autoScheduleEnabled: false,
  shiftStartTime: '17:00',
  handoverTime: '02:00',
  shiftEndTime: '08:30',
  manualOverrideSlot: null,
  manualOverridePeriodKey: null,
  manualDoctorOverrideShiftKey: null,
  adminPin: '1234',
  lastUpdatedAt: Date.now(),
  ext1Label: 'BT (Tomografi) Odası',
  ext1Number: '1234',
  ext2Label: 'MR Konsolu',
  ext2Number: '1235',
  ext3Label: 'Raporlama / Sekreterlik',
  ext3Number: '1236',
  workHoursModeEnabled: true,
  holidayOverrideDateKey: null,
  monthlySchedule: {}
};

const LOCAL_STORAGE_SHIFT_KEY = 'radiology_router_shift_state_v1';
const LOCAL_STORAGE_ROSTER_KEY = 'radiology_router_roster_v1';

// ============================================================================
// ROBUST TIME, SCHEDULE & HOLIDAY HELPERS
// ============================================================================
function getLocalDateKey(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const RELIGIOUS_FULL_HOLIDAYS: Record<string, string> = {
  '2026-03-20': 'Ramazan Bayramı (1. Gün)',
  '2026-03-21': 'Ramazan Bayramı (2. Gün)',
  '2026-03-22': 'Ramazan Bayramı (3. Gün)',
  '2026-05-27': 'Kurban Bayramı (1. Gün)',
  '2026-05-28': 'Kurban Bayramı (2. Gün)',
  '2026-05-29': 'Kurban Bayramı (3. Gün)',
  '2026-05-30': 'Kurban Bayramı (4. Gün)',
  '2027-03-09': 'Ramazan Bayramı (1. Gün)',
  '2027-03-10': 'Ramazan Bayramı (2. Gün)',
  '2027-03-11': 'Ramazan Bayramı (3. Gün)',
  '2027-05-16': 'Kurban Bayramı (1. Gün)',
  '2027-05-17': 'Kurban Bayramı (2. Gün)',
  '2027-05-18': 'Kurban Bayramı (3. Gün)',
  '2027-05-19': 'Kurban Bayramı (4. Gün) & 19 Mayıs',
  '2028-02-26': 'Ramazan Bayramı (1. Gün)',
  '2028-02-27': 'Ramazan Bayramı (2. Gün)',
  '2028-02-28': 'Ramazan Bayramı (3. Gün)',
  '2028-05-05': 'Kurban Bayramı (1. Gün)',
  '2028-05-06': 'Kurban Bayramı (2. Gün)',
  '2028-05-07': 'Kurban Bayramı (3. Gün)',
  '2028-05-08': 'Kurban Bayramı (4. Gün)'
};

const RELIGIOUS_EVE_HALF_DAYS: Record<string, string> = {
  '2026-03-19': 'Ramazan Bayramı Arefesi (Yarım Gün)',
  '2026-05-26': 'Kurban Bayramı Arefesi (Yarım Gün)',
  '2027-03-08': 'Ramazan Bayramı Arefesi (Yarım Gün)',
  '2027-05-15': 'Kurban Bayramı Arefesi (Yarım Gün)',
  '2028-02-25': 'Ramazan Bayramı Arefesi (Yarım Gün)',
  '2028-05-04': 'Kurban Bayramı Arefesi (Yarım Gün)'
};

function checkTurkishPublicHoliday(date: Date): { isHoliday: boolean; name: string | null } {
  const d = date.getDate();
  const m = date.getMonth() + 1;
  const hour = date.getHours();
  const dateKey = getLocalDateKey(date);

  if (RELIGIOUS_FULL_HOLIDAYS[dateKey]) {
    return { isHoliday: true, name: RELIGIOUS_FULL_HOLIDAYS[dateKey] };
  }
  if (RELIGIOUS_EVE_HALF_DAYS[dateKey] && hour >= 13) {
    return { isHoliday: true, name: RELIGIOUS_EVE_HALF_DAYS[dateKey] };
  }

  if (m === 1 && d === 1) return { isHoliday: true, name: 'Yılbaşı Tatili' };
  if (m === 4 && d === 23) return { isHoliday: true, name: '23 Nisan Ulusal Egemenlik ve Çocuk Bayramı' };
  if (m === 5 && d === 1) return { isHoliday: true, name: '1 Mayıs Emek ve Dayanışma Günü' };
  if (m === 5 && d === 19) return { isHoliday: true, name: "19 Mayıs Atatürk'ü Anma, Gençlik ve Spor Bayramı" };
  if (m === 7 && d === 15) return { isHoliday: true, name: '15 Temmuz Demokrasi ve Milli Birlik Günü' };
  if (m === 8 && d === 30) return { isHoliday: true, name: '30 Ağustos Zafer Bayramı' };
  if (m === 10 && d === 28 && hour >= 13) return { isHoliday: true, name: '28 Ekim Cumhuriyet Bayramı Arefesi (Yarım Gün)' };
  if (m === 10 && d === 29) return { isHoliday: true, name: '29 Ekim Cumhuriyet Bayramı' };

  return { isHoliday: false, name: null };
}

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
  const startMin = timeToMinutes(shiftState.shiftStartTime || '17:00');
  const handoverMin = timeToMinutes(shiftState.handoverTime || '02:00');
  const endMin = timeToMinutes(shiftState.shiftEndTime || '08:30');

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

function normalizePersonName(nameStr: string): string {
  if (!nameStr) return '';
  return nameStr
    .toLocaleLowerCase('tr-TR')
    .replace(/^(uzm\.?\s*dr\.?|asist\.?\s*dr\.?|arş\.?\s*gör\.?\s*dr\.?|prof\.?\s*dr\.?|doç\.?\s*dr\.?|dr\.?|doktor)\s+/i, '')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ı/g, 'i')
    .replace(/i̇/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strict, safe doctor matcher that NEVER guesses blindly
function matchDoctorFromRoster(rawInput: string, doctors: Doctor[]): Doctor | null {
  const normInput = normalizePersonName(rawInput);
  if (!normInput || normInput.length < 3) return null;

  // 1. Exact normalized match
  for (const doc of doctors) {
    if (normalizePersonName(doc.name) === normInput) {
      return doc;
    }
  }

  // 2. All tokens in input match tokens in doctor's name (e.g. "Halit Muhittin" or "Ahmet Emin")
  const inputTokens = normInput.split(' ').filter((t) => t.length >= 2);
  if (inputTokens.length === 0) return null;

  const tokenMatches = doctors.filter((doc) => {
    const docTokens = normalizePersonName(doc.name).split(' ');
    return inputTokens.every((t) => docTokens.includes(t));
  });

  if (tokenMatches.length === 1) {
    return tokenMatches[0];
  }

  return null;
}

// Calculates which calendar date's shift is currently active
// Weekdays: Shift starts 17:00, ends 08:30 next morning
// Weekends & Holidays: Shift starts 09:00, ends 09:00 next morning (or 08:30 if next morning is a working weekday)
function getEffectiveShiftDateKey(nowDate: Date, holidayOverrideDateKey?: string | null): string {
  const currentMin = nowDate.getHours() * 60 + nowDate.getMinutes();
  const dayOfWeek = nowDate.getDay(); // 0: Sun, 6: Sat
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const todayKey = getLocalDateKey(nowDate);
  const isTodayHoliday =
    checkTurkishPublicHoliday(nowDate).isHoliday || holidayOverrideDateKey === todayKey;

  const morningCutoffMin = isWeekend || isTodayHoliday ? 9 * 60 : 8 * 60 + 30;

  const effective = new Date(nowDate.getTime());
  if (currentMin < morningCutoffMin) {
    // Still in yesterday's overnight shift
    effective.setDate(effective.getDate() - 1);
  }
  return getLocalDateKey(effective);
}

// ============================================================================
// MAIN APPLICATION COMPONENT
// ============================================================================
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);

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

  const [nowDate, setNowDate] = useState(() => new Date());

  const [isAdminUnlocked, setIsAdminUnlocked] = useState(false);
  const [viewMode, setViewMode] = useState<'er_caller' | 'admin_panel'>('er_caller');
  const [adminTab, setAdminTab] = useState<
    'shift_control' | 'monthly_calendar' | 'roster' | 'share_security'
  >('shift_control');

  // Accordion UI States for Emergency Night Interface
  const [showBackupDoctor, setShowBackupDoctor] = useState(false);
  const [showExtensions, setShowExtensions] = useState(false);

  // Admin draft fields for internal hospital extensions
  const [draftExt1Label, setDraftExt1Label] = useState(shiftState.ext1Label || 'BT (Tomografi) Odası');
  const [draftExt1Number, setDraftExt1Number] = useState(shiftState.ext1Number || '1234');
  const [draftExt2Label, setDraftExt2Label] = useState(shiftState.ext2Label || 'MR Konsolu');
  const [draftExt2Number, setDraftExt2Number] = useState(shiftState.ext2Number || '1235');
  const [draftExt3Label, setDraftExt3Label] = useState(shiftState.ext3Label || 'Raporlama / Sekreterlik');
  const [draftExt3Number, setDraftExt3Number] = useState(shiftState.ext3Number || '1236');

  useEffect(() => {
    setDraftExt1Label(shiftState.ext1Label || 'BT (Tomografi) Odası');
    setDraftExt1Number(shiftState.ext1Number || '');
    setDraftExt2Label(shiftState.ext2Label || 'MR Konsolu');
    setDraftExt2Number(shiftState.ext2Number || '');
    setDraftExt3Label(shiftState.ext3Label || 'Raporlama / Sekreterlik');
    setDraftExt3Number(shiftState.ext3Number || '');
  }, [shiftState.lastUpdatedAt]);

  const [showPinModal, setShowPinModal] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState('');

  const [editingDoctor, setEditingDoctor] = useState<Doctor | null>(null);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkText, setBulkText] = useState('');

  // Monthly Calendar Importer States
  const [monthlyImportText, setMonthlyImportText] = useState('');
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [selectedCalendarMonth, setSelectedCalendarMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  const [newPinInput, setNewPinInput] = useState('');
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast((prev) => (prev?.message === message ? null : prev));
    }, 3500);
  };

  // 1. Live Clock Effect (Updates every 10 seconds)
  useEffect(() => {
    const interval = setInterval(() => {
      setNowDate(new Date());
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  // 2. Cross-Tab Listener
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

  // 3. Firebase Auth
  useEffect(() => {
    let isMounted = true;
    if (!auth || !db) {
      setLoading(false);
      return;
    }

    const safetyTimer = setTimeout(() => {
      if (isMounted) setLoading(false);
    }, 2500);

    const initAuth = async () => {
      try {
        if (window.__initial_auth_token) {
          await signInWithCustomToken(auth!, window.__initial_auth_token);
        } else {
          await signInAnonymously(auth!);
        }
      } catch (err) {
        console.error('Firebase Auth warning:', err);
        if (isMounted) {
          setSyncError('Canlı sunucu bağlantısı kurulamadı, yerel modda çalışıyor.');
          setLoading(false);
        }
      }
    };

    initAuth();

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (isMounted) {
        setUser(currentUser);
        if (!currentUser) setLoading(false);
      }
    });

    return () => {
      isMounted = false;
      clearTimeout(safetyTimer);
      unsubscribe();
    };
  }, []);

  // 4. Firestore Real-time Snapshot (Preserves all existing doctors & shift state)
  useEffect(() => {
    if (!db || !user) return;

    const appId = 'radyoloji-yonlendirici';
    const shiftDocRef = doc(db, 'artifacts', appId, 'public', 'data', 'radiology_router', 'current_shift');
    const rosterDocRef = doc(db, 'artifacts', appId, 'public', 'data', 'radiology_router', 'department_roster');

    const unsubShift = onSnapshot(
      shiftDocRef,
      async (snapshot) => {
        if (snapshot.exists()) {
          const remoteData = snapshot.data() as ShiftState;
          setShiftState((prev) => ({ ... DEFAULT_SHIFT_STATE, ...prev, ...remoteData }));
          localStorage.setItem(LOCAL_STORAGE_SHIFT_KEY, JSON.stringify(remoteData));
        } else {
          try {
            await setDoc(shiftDocRef, shiftState);
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
        if (snapshot.exists() && Array.isArray(snapshot.data().doctors) && snapshot.data().doctors.length > 0) {
          const remoteDocs = snapshot.data().doctors as Doctor[];
          setDoctors(remoteDocs);
          localStorage.setItem(LOCAL_STORAGE_ROSTER_KEY, JSON.stringify(remoteDocs));
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

  // 5. Holiday & Work Hours Evaluation
  const todayDateKey = useMemo(() => getLocalDateKey(nowDate), [nowDate]);
  const officialHoliday = useMemo(() => checkTurkishPublicHoliday(nowDate), [nowDate]);
  const isManualHolidayToday = Boolean(
    shiftState.holidayOverrideDateKey && shiftState.holidayOverrideDateKey === todayDateKey
  );

  const isWorkHours = useMemo(() => {
    if (shiftState.workHoursModeEnabled === false) return false;
    if (isManualHolidayToday) return false;
    if (officialHoliday.isHoliday) return false;

    const day = nowDate.getDay();
    const isWeekday = day >= 1 && day <= 5;
    const currentMin = nowDate.getHours() * 60 + nowDate.getMinutes();
    const startMin = 8 * 60 + 30; // 08:30
    const endMin = 17 * 60;       // 17:00

    return isWeekday && currentMin >= startMin && currentMin < endMin;
  }, [nowDate, shiftState.workHoursModeEnabled, isManualHolidayToday, officialHoliday.isHoliday]);

  // 6. Active Shift Date Key & Safe Monthly Calendar Resolution
  const effectiveShiftDateKey = useMemo(() => {
    return getEffectiveShiftDateKey(nowDate, shiftState.holidayOverrideDateKey);
  }, [nowDate, shiftState.holidayOverrideDateKey]);

  const scheduledForCurrentShift = useMemo(() => {
    if (!shiftState.monthlySchedule) return null;
    return shiftState.monthlySchedule[effectiveShiftDateKey] || null;
  }, [shiftState.monthlySchedule, effectiveShiftDateKey]);

  const isCurrentShiftManuallyOverridden =
    shiftState.manualDoctorOverrideShiftKey === effectiveShiftDateKey;

  // Resolve Slot 1 & Slot 2 Doctors:
  // If there is a monthly schedule entry for the active shift AND the admin hasn't manually overridden today's shift, use the monthly schedule.
  // Otherwise, use the manual slot1DoctorId / slot2DoctorId.
  const effectiveSlot1Id =
    scheduledForCurrentShift && !isCurrentShiftManuallyOverridden
      ? scheduledForCurrentShift.slot1Id
      : shiftState.slot1DoctorId;

  const effectiveSlot2Id =
    scheduledForCurrentShift && !isCurrentShiftManuallyOverridden
      ? scheduledForCurrentShift.slot2Id
      : shiftState.slot2DoctorId;

  const effectiveSingleMode =
    scheduledForCurrentShift && !isCurrentShiftManuallyOverridden
      ? scheduledForCurrentShift.slot1Id === scheduledForCurrentShift.slot2Id
      : shiftState.singleDoctorMode;

  const shiftEvaluation = useMemo(() => {
    return evaluateActiveShiftSlot(
      { ...shiftState, singleDoctorMode: effectiveSingleMode },
      nowDate
    );
  }, [shiftState, effectiveSingleMode, nowDate]);

  const slot1Doctor = useMemo(() => {
    return doctors.find((d) => d.id === effectiveSlot1Id) || doctors[0] || null;
  }, [doctors, effectiveSlot1Id]);

  const slot2Doctor = useMemo(() => {
    return doctors.find((d) => d.id === effectiveSlot2Id) || doctors[1] || doctors[0] || null;
  }, [doctors, effectiveSlot2Id]);

  const activeDoctor =
    shiftEvaluation.activeSlot === 2 && !effectiveSingleMode ? slot2Doctor : slot1Doctor;

  const backupDoctor = !effectiveSingleMode
    ? shiftEvaluation.activeSlot === 1
      ? slot2Doctor
      : slot1Doctor
    : null;

  const configuredExtensions = useMemo(() => {
    const list = [
      { label: shiftState.ext1Label || 'BT (Tomografi) Odası', num: shiftState.ext1Number },
      { label: shiftState.ext2Label || 'MR Konsolu', num: shiftState.ext2Number },
      { label: shiftState.ext3Label || 'Raporlama / Sekreterlik', num: shiftState.ext3Number }
    ];
    return list.filter((item) => item.num && item.num.trim().length > 0);
  }, [shiftState]);

  // 7. Persistence & Cloud Sync
  const saveShiftUpdate = async (partialUpdate: Partial<ShiftState>) => {
    const nextState: ShiftState = {
      ...shiftState,
      ...partialUpdate,
      lastUpdatedAt: Date.now()
    };

    setShiftState(nextState);

    try {
      localStorage.setItem(LOCAL_STORAGE_SHIFT_KEY, JSON.stringify(nextState));
      if (broadcastChannel) {
        broadcastChannel.postMessage({ type: 'SHIFT_UPDATE', payload: nextState });
      }
    } catch (e) {
      console.error('LocalStorage write error:', e);
    }

    if (db && user) {
      const appId = 'radyoloji-yonlendirici';
      const shiftDocRef = doc(db, 'artifacts', appId, 'public', 'data', 'radiology_router', 'current_shift');
      try {
        await setDoc(shiftDocRef, nextState);
      } catch (err) {
        console.error('Firestore shift write error:', err);
      }
    }
  };

  const saveRosterUpdate = async (
    nextDoctors: Doctor[],
    toastMsg: string | null = 'Doktor listesi güncellendi'
  ) => {
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
      const appId = 'radyoloji-yonlendirici';
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

  // Manual doctor selection in Tab 1 (Safely overrides monthly schedule for current shift)
  const handleManualDoctorChange = async (slot: 1 | 2, newDoctorId: string) => {
    const nextSlot1 = slot === 1 ? newDoctorId : effectiveSlot1Id;
    const nextSlot2 = slot === 2 ? newDoctorId : effectiveSlot2Id;

    await saveShiftUpdate({
      slot1DoctorId: nextSlot1,
      slot2DoctorId: nextSlot2,
      manualDoctorOverrideShiftKey: effectiveShiftDateKey
    });

    const docObj = doctors.find((d) => d.id === newDoctorId);
    showToast(`${slot}. Nöbetçi manuel olarak ${docObj?.name} seçildi`, 'success');
  };

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
    showToast(`Çağrı yönlendirilen nöbetçi ${targetDoc?.name} olarak belirlendi`, 'success');
  };

  // Safe, Strict Monthly Schedule Parser (Supports Excel Tabs, Slashes, Commas)
  const handleParseMonthlySchedule = () => {
    if (!monthlyImportText.trim()) {
      showToast('Lütfen aylık nöbet tablosunu yapıştırın.', 'error');
      return;
    }

    const lines = monthlyImportText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const newSchedule: Record<string, DailyScheduleEntry> = {
      ...(shiftState.monthlySchedule || {})
    };
    const warnings: string[] = [];
    let matchedCount = 0;

    const [defaultYear, defaultMonth] = selectedCalendarMonth.split('-');

    lines.forEach((line, idx) => {
      // Match either full date (01.11.2026, 1/11) or leading day number at start of line
      const fullDateMatch = line.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/);
      const dayOnlyMatch = !fullDateMatch ? line.match(/^(\d{1,2})(?:\s+|\t|[-–—:|.;,])+/) : null;

      let fullDateKey = '';
      let remainderLine = '';

      if (fullDateMatch) {
        const day = String(parseInt(fullDateMatch[1], 10)).padStart(2, '0');
        const month = String(parseInt(fullDateMatch[2], 10)).padStart(2, '0');
        const year = fullDateMatch[3]
          ? fullDateMatch[3].length === 2
            ? `20${fullDateMatch[3]}`
            : fullDateMatch[3]
          : defaultYear;
        fullDateKey = `${year}-${month}-${day}`;
        remainderLine = line.slice(fullDateMatch[0].length);
      } else if (dayOnlyMatch) {
        const dayNum = parseInt(dayOnlyMatch[1], 10);
        if (dayNum >= 1 && dayNum <= 31) {
          const day = String(dayNum).padStart(2, '0');
          fullDateKey = `${defaultYear}-${defaultMonth}-${day}`;
          remainderLine = line.slice(dayOnlyMatch[0].length);
        }
      }

      if (!fullDateKey) return;

      // Remove weekday names if present in Excel paste
      const cleanedRemainder = remainderLine.replace(
        /\b(pazartesi|salı|çarşamba|perşembe|cuma|cumartesi|pazar|pzt|sal|çar|per|cum|cmt|paz)\b/gi,
        ' '
      );

      // Split by Excel Tab (\t), slash, pipe, comma, semicolon, or hyphen
      const rawSegments = cleanedRemainder
        .split(/[\t/|&,;]+|\s+-\s+|\s+–\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 3);

      const matchedDocs: Doctor[] = [];
      const unmatchedNames: string[] = [];

      rawSegments.forEach((seg) => {
        const found = matchDoctorFromRoster(seg, doctors);
        if (found) {
          matchedDocs.push(found);
        } else if (/[a-zA-ZğüşıöçĞÜŞİÖÇ]{3,}/.test(seg)) {
          unmatchedNames.push(seg);
        }
      });

      if (matchedDocs.length >= 2) {
        newSchedule[fullDateKey] = {
          slot1Id: matchedDocs[0].id,
          slot2Id: matchedDocs[1].id
        };
        matchedCount++;
      } else if (matchedDocs.length === 1 && unmatchedNames.length === 0) {
        newSchedule[fullDateKey] = {
          slot1Id: matchedDocs[0].id,
          slot2Id: matchedDocs[0].id
        };
        matchedCount++;
      } else {
        warnings.push(
          `Satır ${idx + 1} (${fullDateKey}): "${unmatchedNames.join(', ') || remainderLine.trim()}" doktor listesinde bulunamadı.`
        );
      }
    });

    setImportWarnings(warnings);

    if (matchedCount > 0) {
      saveShiftUpdate({
        monthlySchedule: newSchedule,
        manualDoctorOverrideShiftKey: null
      });
      showToast(
        warnings.length > 0
          ? `${matchedCount} gün kaydedildi, ${warnings.length} satırda eşleşmeyen isim var.`
          : `${matchedCount} günlük nöbet takvimi hatasız kaydedildi!`,
        warnings.length > 0 ? 'error' : 'success'
      );
      if (warnings.length === 0) {
        setMonthlyImportText('');
      }
    } else {
      showToast('Hiçbir satır eşleşmedi. Doktor isimlerinin Doktorlar sekmesiyle aynı olduğundan emin olun.', 'error');
    }
  };

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

  const handleBulkImport = async () => {
    const lines = bulkText.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      showToast('Lütfen en az bir satır girin.', 'error');
      return;
    }

    const imported: Doctor[] = [];
    lines.forEach((line, idx) => {
      const parts = line.includes('\t')
        ? line.split('\t').map((s) => s.trim())
        : line.includes(',')
        ? line.split(',').map((s) => s.trim())
        : line.split('-').map((s) => s.trim());

      const rawName = parts[0] || `Doktor ${idx + 1}`;
      const name = rawName.toLowerCase().startsWith('dr') ? rawName : `Dr. ${rawName}`;
      const phone = parts[1] || '+90 500 000 0000';

      imported.push({ id: `doc-${Date.now()}-${idx}`, name, phone });
    });

    const nextDoctors = [...doctors, ...imported];
    await saveRosterUpdate(nextDoctors, `${imported.length} doktor listeye eklendi!`);
    setBulkText('');
    setShowBulkModal(false);
  };

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

    await saveRosterUpdate(
      nextDoctors,
      exists ? 'Doktor bilgileri güncellendi' : 'Doktor listeye eklendi'
    );
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
    if (shiftState.slot2DoctorId === docId)
      patch.slot2DoctorId = nextDoctors[1]?.id || fallbackId;
    if (Object.keys(patch).length > 0) await saveShiftUpdate(patch);
  };

  const handleSaveExtensions = (e: React.FormEvent) => {
    e.preventDefault();
    saveShiftUpdate({
      ext1Label: draftExt1Label.trim(),
      ext1Number: draftExt1Number.trim(),
      ext2Label: draftExt2Label.trim(),
      ext2Number: draftExt2Number.trim(),
      ext3Label: draftExt3Label.trim(),
      ext3Number: draftExt3Number.trim()
    });
    showToast('Dahili numaralar kaydedildi!', 'success');
  };

  const generateWhatsAppShareMessage = () => {
    const pageUrl = window.location.href;
    const activeName = activeDoctor?.name || 'Nöbetçi Doktor';
    const activePhone = activeDoctor?.phone || '';

    return (
      `🏥 *DÜZCE ÜNİVERSİTESİ - RADYOLOJİ NÖBETÇİSİ*\n\n` +
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
        <h1 className="text-lg font-bold tracking-tight text-slate-100 text-center">
          Düzce Üniversitesi - Radyoloji Nöbetçisi
        </h1>
        <p className="text-xs text-slate-400 mt-1">Yükleniyor...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-slate-950">
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

      {/* Top Header Bar */}
      <header className="w-full max-w-xl mx-auto px-4 pt-5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Stethoscope className="w-4 h-4 text-emerald-400 shrink-0" />
          <span className="text-xs sm:text-sm font-bold text-slate-300 tracking-tight">
            Düzce Üniversitesi - Radyoloji Nöbetçisi
          </span>
        </div>

        {viewMode === 'admin_panel' ? (
          <button
            onClick={() => setViewMode('er_caller')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold bg-emerald-500 text-slate-950 hover:bg-emerald-400 transition-colors shadow-sm cursor-pointer"
          >
            <Eye className="w-4 h-4" />
            <span>Ana Ekrana Dön</span>
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
                <span>Yönetici Paneli</span>
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

      {/* Main Screen Content */}
      <main className="flex-1 flex flex-col justify-center max-w-xl w-full mx-auto px-4 py-6">
        {viewMode === 'er_caller' ? (
          isWorkHours ? (
            /* 1A. MESAİ SAATLERİ GÖRÜNÜMÜ (08:30 - 17:00) */
            <div className="w-full space-y-4">
              <div className="rounded-3xl bg-slate-900 border-2 border-cyan-500/50 shadow-2xl shadow-cyan-950/20 overflow-hidden p-6 sm:p-8 text-center space-y-6">
                <div className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-full bg-cyan-500/15 border border-cyan-500/30">
                  <Clock className="w-4 h-4 text-cyan-400" />
                  <span className="text-xs sm:text-sm font-extrabold tracking-wider uppercase text-cyan-300">
                    Mesai Saatleri (08:30 – 17:00)
                  </span>
                </div>

                <div className="space-y-2">
                  <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                    Nöbet Henüz Başlamamıştır
                  </h1>
                  <p className="text-xs sm:text-sm text-slate-300 max-w-md mx-auto leading-relaxed">
                    Hafta içi rutin mesai devam etmektedir. Radyoloji birimlerine ve raporlama odalarına aşağıdaki dahili hatlardan ulaşabilirsiniz.
                  </p>
                </div>

                <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-3 text-left">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-800/80">
                    <span className="text-xs font-bold text-cyan-400 flex items-center gap-1.5 uppercase tracking-wider">
                      <Building2 className="w-4 h-4" />
                      <span>Radyoloji Dahili Hatları</span>
                    </span>
                    <span className="text-[11px] text-slate-400">Tıkla Ara / Kopyala</span>
                  </div>

                  {configuredExtensions.length > 0 ? (
                    <div className="space-y-2.5 pt-1">
                      {configuredExtensions.map((item, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between p-3 rounded-xl bg-slate-900/90 border border-slate-800 hover:border-slate-700 transition-colors"
                        >
                          <div className="min-w-0 pr-2">
                            <span className="text-xs sm:text-sm font-semibold text-white block truncate">
                              {item.label}
                            </span>
                            <span className="text-[11px] text-slate-400 font-mono">
                              Dahili: {item.num}
                            </span>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <a
                              href={`tel:${cleanPhoneForTel(item.num)}`}
                              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono font-bold text-xs sm:text-sm transition-all"
                            >
                              <PhoneCall className="w-3.5 h-3.5 stroke-[2.5]" />
                              <span>{item.num}</span>
                            </a>
                            <button
                              type="button"
                              onClick={() =>
                                copyToClipboard(
                                  item.num!,
                                  `${item.label} dahili numarası kopyalandı!`
                                )
                              }
                              className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors cursor-pointer"
                              title="Numarayı Kopyala"
                            >
                              <Copy className="w-3.5 h-3.5 text-cyan-400" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="py-4 text-center text-xs text-slate-400">
                      Henüz dahili hat numarası tanımlanmamıştır. Lütfen hastane santralinden radyoloji birimini isteyiniz.
                    </div>
                  )}
                </div>

                <div className="pt-2 border-t border-slate-800/80">
                  <p className="text-xs sm:text-sm font-medium text-slate-400">
                    İyi çalışmalar dileriz.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            /* 1B. NÖBET SAATLERİ GÖRÜNÜMÜ */
            <div className="w-full space-y-3">
              <div className="rounded-3xl bg-slate-900 border-2 border-emerald-500/60 shadow-2xl shadow-emerald-950/30 overflow-hidden p-6 sm:p-8 text-center space-y-6">
                <div className="inline-flex items-center justify-center gap-2.5 px-4 py-2 rounded-full bg-emerald-500/15 border border-emerald-500/30">
                  <span className="relative flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500" />
                  </span>
                  <span className="text-xs sm:text-sm font-extrabold tracking-wider uppercase text-emerald-300">
                    {officialHoliday.isHoliday
                      ? `Nöbetçi (${officialHoliday.name})`
                      : isManualHolidayToday
                      ? `Nöbetçi (Tatil / İdari İzin)`
                      : `Düzce Üniversitesi - Radyoloji Nöbetçisi`}
                  </span>
                </div>

                <div>
                  <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
                    {activeDoctor?.name || 'Dr. —'}
                  </h1>
                </div>

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

                <div className="pt-4 border-t border-slate-800/80">
                  <p className="text-xs sm:text-sm font-medium text-slate-400">
                    İyi nöbetler dileriz.
                  </p>
                </div>
              </div>

              {/* BACKUP DOCTOR ACCORDION */}
              {!effectiveSingleMode && backupDoctor && (
                <div className="pt-1">
                  <button
                    type="button"
                    onClick={() => setShowBackupDoctor((prev) => !prev)}
                    className="w-full py-2.5 px-4 rounded-2xl bg-slate-900/60 hover:bg-slate-900 border border-slate-800 text-xs font-semibold text-slate-400 hover:text-slate-200 flex items-center justify-center gap-2 transition-all cursor-pointer"
                  >
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span>
                      {showBackupDoctor
                        ? 'Yedek Nöbetçi Bilgisini Gizle'
                        : 'Ulaşılamadı mı? 2. Nöbetçiyi Göster'}
                    </span>
                    {showBackupDoctor ? (
                      <ChevronUp className="w-3.5 h-3.5 text-slate-500" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                    )}
                  </button>

                  {showBackupDoctor && (
                    <div className="mt-2.5 p-4 rounded-3xl bg-slate-900 border border-amber-500/30 text-center space-y-3 shadow-xl">
                      <div className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-bold">
                        <span>2. Nöbetçi (Yedek)</span>
                      </div>

                      <div>
                        <h3 className="text-xl font-bold text-white tracking-tight">
                          {backupDoctor.name}
                        </h3>
                        <a
                          href={`tel:${cleanPhoneForTel(backupDoctor.phone)}`}
                          className="block font-mono text-lg font-bold text-amber-400 mt-0.5 hover:underline"
                        >
                          {backupDoctor.phone}
                        </a>
                      </div>

                      <div className="grid grid-cols-2 gap-2 pt-1">
                        <a
                          href={`tel:${cleanPhoneForTel(backupDoctor.phone)}`}
                          className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs transition-colors cursor-pointer"
                        >
                          <PhoneCall className="w-3.5 h-3.5 stroke-[2.5]" />
                          <span>Hemen Ara</span>
                        </a>
                        <a
                          href={`https://wa.me/${cleanPhoneForWhatsApp(backupDoctor.phone)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-bold text-xs transition-colors cursor-pointer"
                        >
                          <MessageSquare className="w-3.5 h-3.5 text-emerald-400" />
                          <span>WhatsApp</span>
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* INTERNAL EXTENSIONS ACCORDION */}
              {configuredExtensions.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowExtensions((prev) => !prev)}
                    className="w-full py-2.5 px-4 rounded-2xl bg-slate-900/60 hover:bg-slate-900 border border-slate-800 text-xs font-semibold text-slate-400 hover:text-slate-200 flex items-center justify-center gap-2 transition-all cursor-pointer"
                  >
                    <Building2 className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                    <span>
                      {showExtensions
                        ? 'Dahili Hatları Gizle'
                        : 'Hekimlere Ulaşılamadı mı? Dahili Hatlar'}
                    </span>
                    {showExtensions ? (
                      <ChevronUp className="w-3.5 h-3.5 text-slate-500" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                    )}
                  </button>

                  {showExtensions && (
                    <div className="mt-2.5 p-3.5 rounded-2xl bg-slate-900 border border-cyan-500/30 text-left space-y-2 shadow-xl">
                      <div className="flex items-center justify-between pb-1.5 border-b border-slate-800 text-[10px] text-cyan-300 font-bold uppercase tracking-wider">
                        <span>Hastane İçi Dahili Telefonlar</span>
                        <span className="text-slate-400 normal-case">Tıkla Ara / Kopyala</span>
                      </div>

                      <div className="space-y-1.5 pt-1">
                        {configuredExtensions.map((item, idx) => (
                          <div
                            key={idx}
                            className="flex items-center justify-between py-1.5 px-2.5 rounded-xl bg-slate-950/80 border border-slate-800/80"
                          >
                            <span className="text-xs font-medium text-slate-200">{item.label}</span>
                            <div className="flex items-center gap-1.5">
                              <a
                                href={`tel:${cleanPhoneForTel(item.num)}`}
                                className="px-2.5 py-1 rounded-lg bg-cyan-950/80 border border-cyan-500/40 text-cyan-300 font-mono font-bold text-xs hover:bg-cyan-900/60 transition-colors"
                              >
                                {item.num}
                              </a>
                              <button
                                type="button"
                                onClick={() =>
                                  copyToClipboard(
                                    item.num!,
                                    `${item.label} dahili numarası kopyalandı!`
                                  )
                                }
                                className="p-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer"
                                title="Kopyala"
                              >
                                <Copy className="w-3 h-3 text-cyan-400" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        ) : (
          /* ========================================================================= */
          /* 2. ADMIN CONTROL PANEL VIEW                                               */
          /* ========================================================================= */
          <div className="space-y-5">
            {/* Admin Header Banner */}
            <div className="rounded-2xl bg-slate-900 border border-indigo-500/40 p-4 sm:p-5 flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-400 block">
                    Yönetici Paneli
                  </span>
                  <span className="text-[10px] text-slate-500 font-mono">• Designed by Halit</span>
                </div>
                <h2 className="text-lg sm:text-xl font-bold text-white mt-0.5">
                  Aktif Nöbetçi:{' '}
                  <span className="text-emerald-400">{activeDoctor?.name}</span>
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Aktif Nöbet Günü Anahtarı:{' '}
                  <span className="font-mono text-indigo-300">{effectiveShiftDateKey}</span>
                  {scheduledForCurrentShift && !isCurrentShiftManuallyOverridden && (
                    <span className="ml-2 text-emerald-400 font-semibold">
                      (Aylık Takvimden Otomatik)
                    </span>
                  )}
                  {isCurrentShiftManuallyOverridden && (
                    <span className="ml-2 text-amber-400 font-semibold">
                      (Manuel Override Aktif)
                    </span>
                  )}
                </p>
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

            {/* Admin Navigation Tabs */}
            <div className="grid grid-cols-4 gap-1.5 bg-slate-900 p-1.5 rounded-2xl border border-slate-800">
              <button
                onClick={() => setAdminTab('shift_control')}
                className={`py-2 px-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1 transition-all cursor-pointer ${
                  adminTab === 'shift_control'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <ArrowLeftRight className="w-3.5 h-3.5 shrink-0" />
                <span>Nöbetçi Seç</span>
              </button>

              <button
                onClick={() => setAdminTab('monthly_calendar')}
                className={`py-2 px-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1 transition-all cursor-pointer ${
                  adminTab === 'monthly_calendar'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <CalendarDays className="w-3.5 h-3.5 shrink-0" />
                <span>Aylık Takvim</span>
              </button>

              <button
                onClick={() => setAdminTab('roster')}
                className={`py-2 px-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1 transition-all cursor-pointer ${
                  adminTab === 'roster'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Users className="w-3.5 h-3.5 shrink-0" />
                <span>Doktorlar ({doctors.length})</span>
              </button>

              <button
                onClick={() => setAdminTab('share_security')}
                className={`py-2 px-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1 transition-all cursor-pointer ${
                  adminTab === 'share_security'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Share2 className="w-3.5 h-3.5 shrink-0" />
                <span>Dahili &amp; Şifre</span>
              </button>
            </div>

            {/* TAB 1: SHIFT SELECTION & HOLIDAY OVERRIDE */}
            {adminTab === 'shift_control' && (
              <div className="space-y-5">
                <div className="rounded-3xl bg-slate-900 border border-cyan-500/40 p-5 space-y-4 shadow-xl">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center shrink-0 mt-0.5">
                      <Palmtree className="w-5 h-5 text-cyan-400" />
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-white">
                        Mesai Saatleri ve Tatil Kontrolü
                      </h3>
                      <p className="text-xs text-slate-300 mt-0.5">
                        Hafta içi 08:30–17:00 arası dahili hatlar görünür; 17:00&apos;de otomatik nöbetçiye geçer. Hafta sonu ve tatillerde 09:00&apos;da nöbet devredilir.
                      </p>
                    </div>
                  </div>

                  {officialHoliday.isHoliday && (
                    <div className="p-3 rounded-2xl bg-emerald-500/15 border border-emerald-500/40 flex items-center gap-2.5 text-xs text-emerald-300">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>
                        <strong>Otomatik Tatil:</strong> {officialHoliday.name}. Mesai modu kapalı, 24 saat nöbet devrede.
                      </span>
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 flex items-center justify-between gap-3">
                      <div>
                        <span className="text-xs font-bold text-white block">Bugün Tatil / İdari İzin</span>
                        <span className="text-[11px] text-slate-400 block mt-0.5">Sadece bugüne özel mesaiyi iptal eder</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const nextKey = isManualHolidayToday ? null : todayDateKey;
                          saveShiftUpdate({ holidayOverrideDateKey: nextKey });
                          showToast(
                            nextKey ? 'Bugün tatil olarak ayarlandı.' : 'Bugünkü tatil kaldırıldı.',
                            'success'
                          );
                        }}
                        className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all shrink-0 cursor-pointer ${
                          isManualHolidayToday
                            ? 'bg-emerald-500 text-slate-950 shadow-md'
                            : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                        }`}
                      >
                        {isManualHolidayToday ? 'Tatil AÇIK' : 'Normal Gün'}
                      </button>
                    </div>

                    <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 flex items-center justify-between gap-3">
                      <div>
                        <span className="text-xs font-bold text-white block">Hafta İçi Mesai Kuralı</span>
                        <span className="text-[11px] text-slate-400 block mt-0.5">08:30–17:00 dahili hat modu</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const currentlyEnabled = shiftState.workHoursModeEnabled !== false;
                          saveShiftUpdate({ workHoursModeEnabled: !currentlyEnabled });
                          showToast(
                            !currentlyEnabled ? 'Mesai kuralı aktif.' : 'Mesai kuralı kapatıldı (7/24 nöbet).',
                            'success'
                          );
                        }}
                        className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all shrink-0 cursor-pointer ${
                          shiftState.workHoursModeEnabled !== false
                            ? 'bg-cyan-500 text-slate-950 shadow-md'
                            : 'bg-rose-500/20 border border-rose-500/40 text-rose-300'
                        }`}
                      >
                        {shiftState.workHoursModeEnabled !== false ? 'Kural Aktif' : 'Devre Dışı'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* 1-Tap Manual Override & Slot Selection */}
                <div className="rounded-3xl bg-slate-900 border border-slate-800 p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-base font-bold text-white">
                        Anlık Nöbetçi Yönlendirme (Manuel Override)
                      </h3>
                      <p className="text-xs text-slate-400">
                        Nöbet değişimi olduğunda buradan seçtiğiniz doktor bu nöbet boyunca aylık takvimi geçersiz kılar.
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      {isCurrentShiftManuallyOverridden && scheduledForCurrentShift && (
                        <button
                          type="button"
                          onClick={() => {
                            saveShiftUpdate({ manualDoctorOverrideShiftKey: null });
                            showToast('Aylık takvim otomasyonuna geri dönüldü', 'success');
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-bold cursor-pointer"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>Takvime Dön</span>
                        </button>
                      )}

                      <label className="inline-flex items-center gap-2 text-xs text-slate-300 bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-800 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={effectiveSingleMode}
                          onChange={(e) =>
                            saveShiftUpdate({
                              singleDoctorMode: e.target.checked,
                              manualDoctorOverrideShiftKey: effectiveShiftDateKey
                            })
                          }
                          className="rounded border-slate-700 text-indigo-500 focus:ring-0"
                        />
                        <span>Tek Nöbetçi</span>
                      </label>
                    </div>
                  </div>

                  <div className={`grid grid-cols-1 ${effectiveSingleMode ? '' : 'sm:grid-cols-2'} gap-4`}>
                    <div
                      className={`rounded-2xl p-4 border-2 transition-all flex flex-col justify-between gap-4 ${
                        shiftEvaluation.activeSlot === 1
                          ? 'bg-emerald-950/25 border-emerald-500'
                          : 'bg-slate-950/60 border-slate-800'
                      }`}
                    >
                      <div className="space-y-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-bold uppercase text-slate-400">1. Nöbetçi Doktor</span>
                          {shiftEvaluation.activeSlot === 1 && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500 text-slate-950">
                              <Check className="w-3 h-3 stroke-[3]" /> AKTİF
                            </span>
                          )}
                        </div>

                        <select
                          value={effectiveSlot1Id}
                          onChange={(e) => handleManualDoctorChange(1, e.target.value)}
                          className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2.5 text-sm font-bold text-white focus:outline-none focus:border-emerald-500 cursor-pointer"
                        >
                          {doctors.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name} ({d.phone})
                            </option>
                          ))}
                        </select>
                        <p className="text-xs font-mono text-slate-300">{slot1Doctor?.phone}</p>
                      </div>

                      {!effectiveSingleMode && (
                        <button
                          onClick={() => handleSelectActiveSlot(1)}
                          disabled={shiftEvaluation.activeSlot === 1}
                          className={`w-full py-3 px-4 rounded-xl font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all ${
                            shiftEvaluation.activeSlot === 1
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 cursor-default'
                              : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-md cursor-pointer'
                          }`}
                        >
                          <PhoneCall className="w-4 h-4" />
                          <span>{shiftEvaluation.activeSlot === 1 ? 'Şu Anda Aktif' : 'Bu Doktoru Göster'}</span>
                        </button>
                      )}
                    </div>

                    {!effectiveSingleMode && (
                      <div
                        className={`rounded-2xl p-4 border-2 transition-all flex flex-col justify-between gap-4 ${
                          shiftEvaluation.activeSlot === 2
                            ? 'bg-emerald-950/25 border-emerald-500'
                            : 'bg-slate-950/60 border-slate-800'
                        }`}
                      >
                        <div className="space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold uppercase text-slate-400">2. Nöbetçi Doktor</span>
                            {shiftEvaluation.activeSlot === 2 && (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500 text-slate-950">
                                <Check className="w-3 h-3 stroke-[3]" /> AKTİF
                              </span>
                            )}
                          </div>

                          <select
                            value={effectiveSlot2Id}
                            onChange={(e) => handleManualDoctorChange(2, e.target.value)}
                            className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2.5 text-sm font-bold text-white focus:outline-none focus:border-emerald-500 cursor-pointer"
                          >
                            {doctors.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.name} ({d.phone})
                              </option>
                            ))}
                          </select>
                          <p className="text-xs font-mono text-slate-300">{slot2Doctor?.phone}</p>
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
                          <PhoneCall className="w-4 h-4" />
                          <span>{shiftEvaluation.activeSlot === 2 ? 'Şu Anda Aktif' : 'Bu Doktoru Göster'}</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: MONTHLY CALENDAR IMPORTER & EDITOR */}
            {adminTab === 'monthly_calendar' && (
              <div className="space-y-5">
                <div className="rounded-3xl bg-slate-900 border border-indigo-500/40 p-5 space-y-4 shadow-xl">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-2xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center shrink-0 mt-0.5">
                        <CalendarDays className="w-5 h-5 text-indigo-400" />
                      </div>
                      <div>
                        <h3 className="text-base font-bold text-white">
                          Aylık Nöbet Tablosu Yükleyici (Excel / Metin)
                        </h3>
                        <p className="text-xs text-slate-300 mt-0.5">
                          Excel&apos;den doğrudan kopyalayıp yapıştırabilirsiniz. Yalnızca Doktorlar sekmesinde kayıtlı olan isimler eşleştirilir (yanlış doktor atamasını önlemek için tahmin yürütülmez).
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <label className="text-xs text-slate-400 font-semibold">Ay:</label>
                      <input
                        type="month"
                        value={selectedCalendarMonth}
                        onChange={(e) => setSelectedCalendarMonth(e.target.value)}
                        className="rounded-xl bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs font-mono text-white"
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <textarea
                      rows={6}
                      value={monthlyImportText}
                      onChange={(e) => setMonthlyImportText(e.target.value)}
                      placeholder={`Excel'den doğrudan yapıştırın veya şu formatta girin:\n01.11.2026\tDr. Halit Muhittin\tDr. Kerem Alkan\n02.11.2026 - Dr. Selin Demirci / Dr. Caner Özkan`}
                      className="w-full rounded-2xl bg-slate-950 border border-slate-700 p-3.5 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-indigo-500"
                    />

                    {importWarnings.length > 0 && (
                      <div className="p-3.5 rounded-2xl bg-rose-950/60 border border-rose-500/40 space-y-1.5">
                        <div className="text-xs font-bold text-rose-300 flex items-center gap-1.5">
                          <AlertTriangle className="w-4 h-4 shrink-0" />
                          <span>Eşleşmeyen Satırlar (Lütfen Doktorlar sekmesindeki isimlerle aynı yazın):</span>
                        </div>
                        <ul className="text-[11px] text-rose-200 font-mono space-y-1 max-h-32 overflow-y-auto pl-4 list-disc">
                          {importWarnings.map((w, i) => (
                            <li key={i}>{w}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="flex justify-end gap-2">
                      {monthlyImportText && (
                        <button
                          type="button"
                          onClick={() => {
                            setMonthlyImportText('');
                            setImportWarnings([]);
                          }}
                          className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold cursor-pointer"
                        >
                          Temizle
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={handleParseMonthlySchedule}
                        className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-lg shadow-indigo-600/25 transition-all cursor-pointer"
                      >
                        Aylık Tabloyu İşle ve Kaydet
                      </button>
                    </div>
                  </div>
                </div>

                {/* Editable Monthly Schedule List */}
                <div className="rounded-3xl bg-slate-900 border border-slate-800 p-5 space-y-3">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                    <div>
                      <h3 className="text-sm font-bold text-white">Kayıtlı Aylık Nöbet Takvimi</h3>
                      <p className="text-[11px] text-slate-400">
                        İstediğiniz günün nöbetçisini açılır listeden değiştirebilirsiniz.
                      </p>
                    </div>
                    <span className="text-xs font-mono text-emerald-400">
                      {Object.keys(shiftState.monthlySchedule || {}).length} Gün Kayıtlı
                    </span>
                  </div>

                  <div className="max-h-80 overflow-y-auto space-y-2 pr-1">
                    {Object.keys(shiftState.monthlySchedule || {})
                      .sort()
                      .map((dateKey) => {
                        const daySched = shiftState.monthlySchedule![dateKey];
                        const isTodayShift = dateKey === effectiveShiftDateKey;
                        return (
                          <div
                            key={dateKey}
                            className={`flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2.5 rounded-xl border text-xs ${
                              isTodayShift
                                ? 'bg-emerald-950/30 border-emerald-500/50'
                                : 'bg-slate-950 border-slate-800/80'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-bold text-indigo-300">{dateKey}</span>
                              {isTodayShift && (
                                <span className="px-2 py-0.5 rounded-full bg-emerald-500 text-slate-950 font-bold text-[10px]">
                                  Aktif Nöbet
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-1.5 flex-wrap">
                              <select
                                value={daySched.slot1Id}
                                onChange={(e) => {
                                  const nextSched = {
                                    ...shiftState.monthlySchedule,
                                    [dateKey]: { ...daySched, slot1Id: e.target.value }
                                  };
                                  saveShiftUpdate({ monthlySchedule: nextSched });
                                }}
                                className="rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-xs text-white"
                              >
                                {doctors.map((d) => (
                                  <option key={d.id} value={d.id}>
                                    1: {d.name}
                                  </option>
                                ))}
                              </select>

                              <select
                                value={daySched.slot2Id}
                                onChange={(e) => {
                                  const nextSched = {
                                    ...shiftState.monthlySchedule,
                                    [dateKey]: { ...daySched, slot2Id: e.target.value }
                                  };
                                  saveShiftUpdate({ monthlySchedule: nextSched });
                                }}
                                className="rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-xs text-white"
                              >
                                {doctors.map((d) => (
                                  <option key={d.id} value={d.id}>
                                    2: {d.name}
                                  </option>
                                ))}
                              </select>

                              <button
                                onClick={() => {
                                  const nextSched = { ...shiftState.monthlySchedule };
                                  delete nextSched[dateKey];
                                  saveShiftUpdate({ monthlySchedule: nextSched });
                                  showToast(`${dateKey} nöbet kaydı silindi`, 'success');
                                }}
                                className="text-rose-400 hover:text-rose-300 p-1 cursor-pointer"
                                title="Günü Sil"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    {Object.keys(shiftState.monthlySchedule || {}).length === 0 && (
                      <p className="text-xs text-slate-500 text-center py-6">
                        Henüz sisteme işlenmiş aylık nöbet takvimi bulunmuyor. Yukarıdan yapıştırabilirsiniz.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: DOCTOR ROSTER */}
            {adminTab === 'roster' && (
              <div className="rounded-3xl bg-slate-900 border border-slate-800 p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-bold text-white">
                      Radyoloji Doktor Listesi ({doctors.length})
                    </h3>
                    <p className="text-xs text-slate-400">
                      Kayıtlı doktorlarınız bulutta güvenle saklanır.
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
                      onClick={() => setEditingDoctor({ id: '', name: 'Dr. ', phone: '+90 5' })}
                      className="px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                    >
                      <Plus className="w-4 h-4 stroke-[2.5]" />
                      <span>Doktor Ekle</span>
                    </button>
                  </div>
                </div>

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
                        <label className="text-[11px] text-slate-400 block mb-1">Doktor Adı *</label>
                        <input
                          type="text"
                          required
                          value={editingDoctor.name}
                          onChange={(e) =>
                            setEditingDoctor({ ...editingDoctor, name: e.target.value })
                          }
                          className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">Telefon *</label>
                        <input
                          type="text"
                          required
                          value={editingDoctor.phone}
                          onChange={(e) =>
                            setEditingDoctor({ ...editingDoctor, phone: e.target.value })
                          }
                          className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-sm font-mono text-white"
                        />
                      </div>
                    </div>

                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        type="submit"
                        className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-bold text-white cursor-pointer"
                      >
                        Kaydet
                      </button>
                    </div>
                  </form>
                )}

                <div className="divide-y divide-slate-800/80">
                  {doctors.map((docItem) => (
                    <div
                      key={docItem.id}
                      className="py-3 flex items-center justify-between gap-2"
                    >
                      <div>
                        <span className="font-bold text-white text-sm">{docItem.name}</span>
                        <p className="text-xs font-mono text-slate-400">{docItem.phone}</p>
                      </div>
                      <div className="flex items-center gap-1.5">
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
                  ))}
                </div>
              </div>
            )}

            {/* TAB 4: INTERNAL EXTENSIONS, SHARE & PIN */}
            {adminTab === 'share_security' && (
              <div className="space-y-4">
                <div className="rounded-3xl bg-slate-900 border border-cyan-500/30 p-5 space-y-4">
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-cyan-400" />
                    <span>Hastane İçi Dahili Hatlar (Maks. 3 Hat)</span>
                  </h3>

                  <form onSubmit={handleSaveExtensions} className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="p-3 bg-slate-950 rounded-2xl border border-slate-800 space-y-2">
                        <span className="text-[10px] font-bold text-cyan-400 uppercase">
                          1. Dahili Hat
                        </span>
                        <input
                          type="text"
                          value={draftExt1Label}
                          onChange={(e) => setDraftExt1Label(e.target.value)}
                          placeholder="Birim Adı"
                          className="w-full bg-slate-900 border border-slate-700 rounded-xl px-2.5 py-1.5 text-xs text-white"
                        />
                        <input
                          type="text"
                          value={draftExt1Number}
                          onChange={(e) => setDraftExt1Number(e.target.value)}
                          placeholder="No"
                          className="w-full bg-slate-900 border border-slate-700 rounded-xl px-2.5 py-1.5 text-xs font-mono text-cyan-300"
                        />
                      </div>
                      <div className="p-3 bg-slate-950 rounded-2xl border border-slate-800 space-y-2">
                        <span className="text-[10px] font-bold text-cyan-400 uppercase">
                          2. Dahili Hat
                        </span>
                        <input
                          type="text"
                          value={draftExt2Label}
                          onChange={(e) => setDraftExt2Label(e.target.value)}
                          placeholder="Birim Adı"
                          className="w-full bg-slate-900 border border-slate-700 rounded-xl px-2.5 py-1.5 text-xs text-white"
                        />
                        <input
                          type="text"
                          value={draftExt2Number}
                          onChange={(e) => setDraftExt2Number(e.target.value)}
                          placeholder="No"
                          className="w-full bg-slate-900 border border-slate-700 rounded-xl px-2.5 py-1.5 text-xs font-mono text-cyan-300"
                        />
                      </div>
                      <div className="p-3 bg-slate-950 rounded-2xl border border-slate-800 space-y-2">
                        <span className="text-[10px] font-bold text-cyan-400 uppercase">
                          3. Dahili Hat
                        </span>
                        <input
                          type="text"
                          value={draftExt3Label}
                          onChange={(e) => setDraftExt3Label(e.target.value)}
                          placeholder="Birim Adı"
                          className="w-full bg-slate-900 border border-slate-700 rounded-xl px-2.5 py-1.5 text-xs text-white"
                        />
                        <input
                          type="text"
                          value={draftExt3Number}
                          onChange={(e) => setDraftExt3Number(e.target.value)}
                          placeholder="No"
                          className="w-full bg-slate-900 border border-slate-700 rounded-xl px-2.5 py-1.5 text-xs font-mono text-cyan-300"
                        />
                      </div>
                    </div>

                    <div className="flex justify-end pt-1">
                      <button
                        type="submit"
                        className="px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-bold text-xs cursor-pointer"
                      >
                        Dahili Numaraları Kaydet
                      </button>
                    </div>
                  </form>
                </div>

                <div className="rounded-3xl bg-slate-900 border border-slate-800 p-5 space-y-4">
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <Share2 className="w-4 h-4 text-emerald-400" />
                    <span>WhatsApp Grubunda Paylaş</span>
                  </h3>
                  <div className="flex flex-wrap gap-2.5">
                    <button
                      onClick={() => {
                        const msg = generateWhatsAppShareMessage();
                        window.open(
                          `https://wa.me/?text=${encodeURIComponent(msg)}`,
                          '_blank'
                        );
                      }}
                      className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-2 cursor-pointer"
                    >
                      <MessageSquare className="w-4 h-4" />
                      <span>WhatsApp ile Gönder</span>
                    </button>
                    <button
                      onClick={() =>
                        copyToClipboard(window.location.href, 'Bağlantı kopyalandı!')
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
                      Güncelle
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Micro-Footer Creator Credit */}
      <footer className="w-full text-center py-6 mt-auto">
        <p className="text-[11px] font-normal tracking-wide text-slate-600 selection:bg-transparent">
          Designed with care by Halit{' '}
          <span className="text-slate-700 mx-1">•</span>{' '}
          <span className="text-slate-600">Düzce Radyoloji</span>
        </p>
      </footer>

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
              <input
                type="password"
                autoFocus
                value={pinInput}
                onChange={(e) => {
                  setPinInput(e.target.value);
                  setPinError('');
                }}
                placeholder="Şifrenizi girin"
                className="w-full text-center text-lg font-mono font-bold rounded-2xl bg-slate-950 border border-slate-700 py-3.5 px-4 text-white placeholder:text-slate-500 focus:outline-none focus:border-indigo-500"
              />
              {pinError && (
                <p className="text-xs text-rose-400 text-center font-medium">{pinError}</p>
              )}
              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => setShowPinModal(false)}
                  className="w-full py-3 rounded-2xl bg-slate-800 text-slate-300 font-semibold text-sm cursor-pointer"
                >
                  İptal
                </button>
                <button
                  type="submit"
                  className="w-full py-3 rounded-2xl bg-indigo-600 text-white font-bold text-sm shadow-lg cursor-pointer"
                >
                  Giriş Yap
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: BULK IMPORT */}
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
            <textarea
              rows={6}
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={`Dr. Halit Muhittin, +90 532 000 0000`}
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
