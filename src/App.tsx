import React, { useState, useEffect, useRef, Suspense } from 'react';
import {
  Trophy,
  History,
  PlusCircle,
  Wallet,
  Download,
  Trash2,
  Upload,
  Check,
  X,
  AlertCircle,
  TrendingUp,
  TrendingDown,
  Users,
  LayoutDashboard,
  ChevronRight,
  ArrowUpRight,
  ArrowDownRight,
  Link2,
  Merge,
  Plus,
  ScrollText,
  Clock,
  Megaphone,
  Spade,
  DoorOpen,
  Handshake,
  Zap
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useDropzone } from 'react-dropzone';
import { extractPokerResults, ExtractedResult } from './services/geminiService';
import { exportLedgerToPdf } from './utils/pdfExport';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import * as XLSX from 'xlsx';
import LiveLogin from './views/LiveLogin';
import LiveLobby from './views/LiveLobby';
import LiveSessionAdmin from './views/LiveSessionAdmin';
import LiveSessionPlayer from './views/LiveSessionPlayer';
import LiveSettlement from './views/LiveSettlement';
import PlayerHistoryModal from './components/PlayerHistoryModal';
import type { LiveUser } from './services/liveApi';
import {
  isPokerNowGameLog,
  parsePokerNowGameLog,
  type PokerNowAttendance,
} from './lib/pokerNowLog';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthName(m: string) {
  return MONTH_NAMES[parseInt(m, 10) - 1] || m;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}

// --- Types ---
interface Player {
  id: number;
  name: string;
  total_profit: number;
}

interface Session {
  id: number;
  date: string;
  note: string;
  results: { name: string; amount: number }[];
  attendance: PokerNowAttendance[];
}

interface Settlement {
  id: number;
  amount: number;
  date: string;
  payer: string;
  payee: string;
  status: string;
}

interface PlayerAlias {
  id: number;
  alias: string;
}

interface PlayerWithAliases {
  id: number;
  name: string;
  aliases: PlayerAlias[];
  session_profit: number;
}

interface PokerNowTracker {
  id: string;
  gameId: string;
  gameUrl: string;
  note: string;
  status: 'active' | 'closed';
  startedAt: number;
  endedAt?: number;
  sessionId: number | null;
  accessToken: string;
}

const POKER_NOW_TRACKERS_KEY = 'poker_now_trackers';

function loadPokerNowTrackers(): PokerNowTracker[] {
  try {
    const stored = JSON.parse(localStorage.getItem(POKER_NOW_TRACKERS_KEY) ?? '[]');
    return Array.isArray(stored)
      ? stored.filter(
          (tracker): tracker is PokerNowTracker =>
            tracker &&
            typeof tracker.id === 'string' &&
            tracker.status === 'active' &&
            typeof tracker.accessToken === 'string'
        )
      : [];
  } catch {
    return [];
  }
}

// --- Components ---

const TabButton = ({ active, onClick, icon: Icon, label }: any) => (
  <button
    onClick={onClick}
    className={cn(
      "flex items-center gap-1.5 px-3 md:px-6 py-3 text-sm font-medium transition-all relative group whitespace-nowrap",
      active ? "text-white" : "text-zinc-500 hover:text-zinc-300"
    )}
  >
    <Icon size={16} className={cn("transition-transform shrink-0", active && "scale-110")} />
    <span className="tracking-wide uppercase text-[9px] md:text-[10px] font-bold">{label}</span>
    {active && (
      <motion.div
        layoutId="activeTab"
        className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500 shadow-[0_0_10px_rgba(79,70,229,0.5)]"
      />
    )}
  </button>
);

type TabId = 'dashboard' | 'sessions' | 'livePlay' | 'players' | 'debts' | 'rules';
const TAB_ORDER: TabId[] = ['dashboard', 'sessions', 'livePlay', 'players', 'debts', 'rules'];
const SWIPE_THRESHOLD = 60;

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('dashboard');
  const [players, setPlayers] = useState<Player[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [playersWithAliases, setPlayersWithAliases] = useState<PlayerWithAliases[]>([]);
  const [pokerNowTrackers, setPokerNowTrackers] =
    useState<PokerNowTracker[]>(loadPokerNowTrackers);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showSettlementModal, setShowSettlementModal] = useState(false);
  const openSettlementModal = useRef(() => setShowSettlementModal(true));
  useEffect(() => { openSettlementModal.current = () => setShowSettlementModal(true); }, [setShowSettlementModal]);
  const [pendingResults, setPendingResults] = useState<ExtractedResult[]>([]);
  const [pendingAttendance, setPendingAttendance] = useState<PokerNowAttendance[]>([]);
  const [sessionNote, setSessionNote] = useState('');
  const [sessionDate, setSessionDate] = useState(new Date().toISOString().split('T')[0]);
  const [isManualEntry, setIsManualEntry] = useState(false);
  const [pokerNowLink, setPokerNowLink] = useState('');
  const [pokerNowNote, setPokerNowNote] = useState('');
  const [isStartingPokerNow, setIsStartingPokerNow] = useState(false);
  const [finishingPokerNowId, setFinishingPokerNowId] = useState<string | null>(null);
  const [pokerNowError, setPokerNowError] = useState<string | null>(null);
  const [newAliasInputs, setNewAliasInputs] = useState<Record<number, string>>({});
  const [mergeSource, setMergeSource] = useState<number | null>(null);
  const [aliasError, setAliasError] = useState<string | null>(null);

  const [settlementData, setSettlementData] = useState({
    payer: '',
    payee: '',
    amount: '',
    date: new Date().toISOString().split('T')[0]
  });

  const [selectedPlayer, setSelectedPlayer] = useState<{ id: number; name: string } | null>(null);
  const handlePlayerClick = (player: Player) => setSelectedPlayer({ id: player.id, name: player.name });
  const handlePlayerKey = (e: React.KeyboardEvent, player: Player) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handlePlayerClick(player);
    }
  };

  // --- Live Play state ---
  const [liveUser, setLiveUser] = useState<LiveUser | null>(null);
  const [liveRoute, setLiveRoute] = useState('lobby');
  const [liveRouteParam, setLiveRouteParam] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem('live_poker_user');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (typeof parsed?.authToken === 'string') {
          setLiveUser(parsed);
        } else {
          localStorage.removeItem('live_poker_user');
        }
      } catch {
        localStorage.removeItem('live_poker_user');
      }
    }
  }, []);

  const navigateLive = (path: string) => {
    const [route, ...rest] = path.split('/');
    setLiveRoute(route);
    setLiveRouteParam(rest.join('/') || null);
  };

  const renderLiveSection = () => {
    if (!liveUser) {
      return (
        <LiveLogin
          onLogin={(u) => {
            setLiveUser(u);
            localStorage.setItem('live_poker_user', JSON.stringify(u));
            setLiveRoute('lobby');
            setLiveRouteParam(null);
          }}
        />
      );
    }
    switch (liveRoute) {
      case 'admin':
        return (
          <LiveSessionAdmin
            user={liveUser}
            sessionCode={liveRouteParam || ''}
            navigate={navigateLive}
          />
        );
      case 'player':
        return (
          <LiveSessionPlayer
            user={liveUser}
            sessionCode={liveRouteParam || ''}
            navigate={navigateLive}
          />
        );
      case 'settlement':
        return (
          <LiveSettlement
            user={liveUser}
            sessionId={liveRouteParam || ''}
            navigate={navigateLive}
          />
        );
      case 'lobby':
      default:
        return (
          <LiveLobby
            user={liveUser}
            onLogout={() => {
              localStorage.removeItem('live_poker_user');
              setLiveUser(null);
              setLiveRoute('lobby');
              setLiveRouteParam(null);
            }}
            navigate={navigateLive}
          />
        );
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    localStorage.setItem(POKER_NOW_TRACKERS_KEY, JSON.stringify(pokerNowTrackers));
  }, [pokerNowTrackers]);

  const fetchData = async () => {
    try {
      const response = await fetch('/api/bootstrap');
      if (!response.ok) throw new Error(`Bootstrap failed (${response.status})`);
      const data = await response.json();
      setPlayers(Array.isArray(data.players) ? data.players : []);
      setSessions(Array.isArray(data.sessions) ? data.sessions : []);
      setSettlements(Array.isArray(data.settlements) ? data.settlements : []);
      setPlayersWithAliases(
        Array.isArray(data.playersWithAliases) ? data.playersWithAliases : []
      );
    } catch (error) {
      console.error('Failed to load application data:', error);
    }
  };

  const onDrop = async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;
    setIsUploading(true);
    setUploadError(null);
    setPendingAttendance([]);

    try {
      let gameLogAttendance: PokerNowAttendance[] = [];
      let resultFile: File | undefined;

      for (const file of acceptedFiles) {
        if (file.name.toLowerCase().endsWith('.csv') || file.type === 'text/csv') {
          const text = await file.text();
          if (isPokerNowGameLog(text)) {
            gameLogAttendance = parsePokerNowGameLog(text);
            continue;
          }
        }
        resultFile ??= file;
      }

      let results: ExtractedResult[];
      if (!resultFile) {
        if (gameLogAttendance.length === 0) {
          throw new Error('No supported session data was found.');
        }
        results = gameLogAttendance.map((player) => ({ name: player.name, amount: 0 }));
      } else if (
        resultFile.type ===
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        resultFile.type === 'application/vnd.ms-excel' ||
        resultFile.name.toLowerCase().endsWith('.xlsx') ||
        resultFile.name.toLowerCase().endsWith('.xls')
      ) {
        const data = new Uint8Array(await resultFile.arrayBuffer());
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const json = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        results = await extractPokerResults(JSON.stringify(json), 'text/plain', true);
      } else if (
        resultFile.name.toLowerCase().endsWith('.csv') ||
        resultFile.type === 'text/csv'
      ) {
        results = await extractPokerResults(await resultFile.text(), 'text/plain', true);
      } else {
        results = await extractPokerResults(
          await readFileAsDataUrl(resultFile),
          resultFile.type
        );
      }

      setPendingAttendance(gameLogAttendance);
      setPendingResults(results);
      setIsManualEntry(!resultFile);
      setShowConfirmModal(true);
    } catch (error: any) {
      console.error("File processing error", error);
      setUploadError(
        error.message ||
          'Failed to process the files. Check that they contain readable poker session data.'
      );
    } finally {
      setIsUploading(false);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/*': [],
      'application/pdf': [],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls'],
      'text/csv': ['.csv'],
    },
    multiple: true
  } as any);

  const startPokerNowTracking = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!pokerNowLink.trim() || isStartingPokerNow) return;
    setPokerNowError(null);
    setIsStartingPokerNow(true);
    const pendingTokenKey = `poker_now_start_token:${pokerNowLink.trim()}`;
    const accessToken =
      localStorage.getItem(pendingTokenKey) ??
      `${crypto.randomUUID()}${crypto.randomUUID()}`;
    localStorage.setItem(pendingTokenKey, accessToken);
    try {
      const response = await fetch('/api/pokernow/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: pokerNowLink,
          note: pokerNowNote,
          accessToken,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not start tracking.');
      setPokerNowTrackers((current) => [
        { ...body.tracker, accessToken },
        ...current.filter((tracker) => tracker.id !== body.tracker.id),
      ]);
      localStorage.removeItem(pendingTokenKey);
      setPokerNowLink('');
      setPokerNowNote('');
    } catch (error) {
      setPokerNowError(
        error instanceof Error ? error.message : 'Could not start PokerNow tracking.'
      );
    } finally {
      setIsStartingPokerNow(false);
    }
  };

  const finalizePokerNowTracking = async (
    tracker: PokerNowTracker,
    file: File
  ) => {
    setPokerNowError(null);
    setFinishingPokerNowId(tracker.id);
    try {
      const text = await file.text();
      if (!isPokerNowGameLog(text)) {
        throw new Error('Choose the PokerNow Game Log CSV, not the ledger CSV.');
      }
      const attendance = parsePokerNowGameLog(text, {
        startAt: tracker.startedAt,
        endAt: Date.now(),
      });
      if (attendance.length === 0) {
        throw new Error('No completed hands were found after tracking started.');
      }
      const response = await fetch(`/api/pokernow/${tracker.id}/finalize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tracker.accessToken}`,
        },
        body: JSON.stringify({
          attendance,
          date: new Date().toISOString().slice(0, 10),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not finalize PokerNow session.');
      setPokerNowTrackers((current) =>
        current.filter((candidate) => candidate.id !== tracker.id)
      );
      await fetchData();
    } catch (error) {
      setPokerNowError(
        error instanceof Error ? error.message : 'Could not finalize PokerNow tracking.'
      );
    } finally {
      setFinishingPokerNowId(null);
    }
  };

  const [isSaving, setIsSaving] = useState(false);

  const handleSaveSession = async () => {
    if (isSaving) return;
    const validResults = pendingResults.filter(r => r.name.trim() && r.amount !== 0);
    if (validResults.length === 0) {
      alert("No players with non-zero amounts. Add at least one entry.");
      return;
    }
    setIsSaving(true);
    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: sessionDate,
          note: sessionNote,
          results: validResults,
          attendance: pendingAttendance,
        })
      });
      if (response.ok) {
        setShowConfirmModal(false);
        setPendingResults([]);
        setPendingAttendance([]);
        setSessionNote('');
        fetchData();
      }
    } catch (error) {
      alert("Failed to save session");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteSession = async (id: number) => {
    if (isSaving) return;
    if (!confirm("Are you sure you want to delete this session?")) return;
    setIsSaving(true);
    try {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      fetchData();
    } catch (error) {
      alert("Failed to delete session");
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateSettlement = async () => {
    if (isSaving) return;
    if (!settlementData.payer || !settlementData.payee || !settlementData.amount) {
      alert("Please fill in all settlement fields");
      return;
    }
    setIsSaving(true);
    try {
      const response = await fetch('/api/settlements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...settlementData,
          amount: parseFloat(settlementData.amount)
        })
      });
      if (response.ok) {
        setShowSettlementModal(false);
        setSettlementData({
          payer: '',
          payee: '',
          amount: '',
          date: new Date().toISOString().split('T')[0]
        });
        fetchData();
      }
    } catch (error) {
      alert("Failed to record settlement");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteSettlement = async (id: number) => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      await fetch(`/api/settlements/${id}`, { method: 'DELETE' });
      fetchData();
    } catch (error) {
      alert("Failed to undo settlement");
    } finally {
      setIsSaving(false);
    }
  };

  const handleRestoreSettlement = async (id: number) => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      await fetch(`/api/settlements/${id}/restore`, { method: 'PATCH' });
      fetchData();
    } catch (error) {
      alert("Failed to restore settlement");
    } finally {
      setIsSaving(false);
    }
  };

  const updatePendingResult = (index: number, field: keyof ExtractedResult, value: string | number) => {
    const newResults = [...pendingResults];
    newResults[index] = { ...newResults[index], [field]: value };
    setPendingResults(newResults);
  };

  const openManualEntry = () => {
    setPendingResults(players.map(p => ({ name: p.name, amount: 0 })));
    setPendingAttendance([]);
    setSessionNote('');
    setSessionDate(new Date().toISOString().split('T')[0]);
    setIsManualEntry(true);
    setShowConfirmModal(true);
  };

  const handleAddAlias = async (playerId: number) => {
    const alias = newAliasInputs[playerId]?.trim();
    if (!alias) return;
    setAliasError(null);
    try {
      const res = await fetch(`/api/players/${playerId}/aliases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias })
      });
      if (!res.ok) {
        const err = await res.json();
        setAliasError(err.error);
        return;
      }
      setNewAliasInputs({ ...newAliasInputs, [playerId]: '' });
      fetchData();
    } catch { setAliasError("Failed to add alias"); }
  };

  const handleRemoveAlias = async (aliasId: number) => {
    try {
      await fetch(`/api/players/aliases/${aliasId}`, { method: 'DELETE' });
      fetchData();
    } catch { alert("Failed to remove alias"); }
  };

  const handleDeletePlayer = async (playerId: number, playerName: string) => {
    if (isSaving) return;
    if (!confirm(`Delete "${playerName}" and all their session data? This cannot be undone.`)) return;
    setIsSaving(true);
    try {
      await fetch(`/api/players/${playerId}`, { method: 'DELETE' });
      fetchData();
    } catch { alert("Failed to delete player"); }
    finally { setIsSaving(false); }
  };

  const handleMergePlayer = async (sourceId: number, targetId: number) => {
    if (isSaving) return;
    if (!confirm("This will merge all sessions and data from the source player into the target. This cannot be undone. Continue?")) return;
    setIsSaving(true);
    try {
      const res = await fetch('/api/players/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId, targetId })
      });
      if (res.ok) {
        setMergeSource(null);
        fetchData();
      }
    } catch { alert("Failed to merge players"); }
    finally { setIsSaving(false); }
  };

  const calculateDebts = () => {
    const winners = players.filter(p => p.total_profit > 0).sort((a, b) => b.total_profit - a.total_profit);
    const losers = players.filter(p => p.total_profit < 0).sort((a, b) => a.total_profit - b.total_profit);

    const debts: { from: string, to: string, amount: number }[] = [];

    let wIdx = 0;
    let lIdx = 0;

    const wBalances = winners.map(p => ({ ...p }));
    const lBalances = losers.map(p => ({ ...p, total_profit: Math.abs(p.total_profit) }));

    while (wIdx < wBalances.length && lIdx < lBalances.length) {
      const amount = Math.min(wBalances[wIdx].total_profit, lBalances[lIdx].total_profit);
      if (amount > 0.01) {
        debts.push({
          from: lBalances[lIdx].name,
          to: wBalances[wIdx].name,
          amount: amount
        });
      }

      wBalances[wIdx].total_profit -= amount;
      lBalances[lIdx].total_profit -= amount;

      if (wBalances[wIdx].total_profit < 0.01) wIdx++;
      if (lBalances[lIdx].total_profit < 0.01) lIdx++;
    }

    return debts;
  };

  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const swipeAxis = useRef<'pending' | 'horizontal' | 'vertical'>('pending');
  const [isTabSwitching, setIsTabSwitching] = useState(false);

  const shouldIgnoreSwipeTarget = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return true;
    if (target.closest('[role="dialog"]')) return true;
    return false;
  };

  const onSwipeStart = (e: React.TouchEvent) => {
    // Live Play has its own internal tab UI; don't hijack swipes there.
    if (activeTab === 'livePlay') {
      swipeStart.current = null;
      return;
    }
    if (isTabSwitching || e.touches.length !== 1 || shouldIgnoreSwipeTarget(e.target)) {
      swipeStart.current = null;
      return;
    }
    const t = e.touches[0];
    swipeStart.current = { x: t.clientX, y: t.clientY };
    swipeAxis.current = 'pending';
  };

  const onSwipeMove = (e: React.TouchEvent) => {
    if (!swipeStart.current || swipeAxis.current === 'vertical') return;
    const t = e.touches[0];
    const dx = t.clientX - swipeStart.current.x;
    const dy = t.clientY - swipeStart.current.y;
    if (swipeAxis.current === 'pending' && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      swipeAxis.current = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
    }
  };

  const onSwipeEnd = (e: React.TouchEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start || swipeAxis.current !== 'horizontal') return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    if (Math.abs(dx) < SWIPE_THRESHOLD) return;
    const currentIdx = TAB_ORDER.indexOf(activeTab);
    const nextIdx = dx < 0 ? currentIdx + 1 : currentIdx - 1;
    if (nextIdx < 0 || nextIdx >= TAB_ORDER.length) return;
    setIsTabSwitching(true);
    setActiveTab(TAB_ORDER[nextIdx]);
  };

  return (
    <div className="min-h-screen text-zinc-100 selection:bg-indigo-500/30 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">

      {/* Header */}
      <header className="bg-black/40 backdrop-blur-xl border-b border-white/5 sticky top-0 z-30">
        <div className="max-w-full mx-auto px-6 md:px-12 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center text-white shadow-xl shadow-indigo-500/20">
              <LayoutDashboard size={24} />
            </div>
            <div>
              <h1 className="font-black text-xl tracking-tighter uppercase italic">Poker Fishes Ledger</h1>
              <p className="hidden sm:block text-[10px] text-zinc-500 font-bold tracking-[0.2em] uppercase">Premium Analytics</p>
            </div>
          </div>

          <button
            onClick={() => exportLedgerToPdf(sessions, players)}
            className="flex items-center gap-2 px-5 py-2.5 bg-white text-black rounded-full text-xs font-black uppercase tracking-widest hover:bg-zinc-200 transition-all shadow-[0_0_20px_rgba(255,255,255,0.1)] active:scale-95"
          >
            <Download size={14} />
            Export PDF
          </button>
        </div>

        <div className="max-w-full mx-auto px-2 md:px-12 flex items-center overflow-x-auto scrollbar-hide">
          <div className="flex bg-white/5 rounded-t-xl px-1 min-w-0 shrink-0">
            <TabButton
              active={activeTab === 'dashboard'}
              onClick={() => setActiveTab('dashboard')}
              icon={Trophy}
              label="Leaderboard"
            />
            <TabButton
              active={activeTab === 'sessions'}
              onClick={() => setActiveTab('sessions')}
              icon={History}
              label="Sessions"
            />
            <TabButton
              active={activeTab === 'livePlay'}
              onClick={() => setActiveTab('livePlay')}
              icon={Zap}
              label="Live Play"
            />
            <TabButton
              active={activeTab === 'players'}
              onClick={() => setActiveTab('players')}
              icon={Users}
              label="Players"
            />
            <TabButton
              active={activeTab === 'debts'}
              onClick={() => setActiveTab('debts')}
              icon={Wallet}
              label="Debts"
            />
            <TabButton
              active={activeTab === 'rules'}
              onClick={() => setActiveTab('rules')}
              icon={ScrollText}
              label="Rules"
            />
          </div>
          {activeTab === 'sessions' && (
            <button
              onClick={openManualEntry}
              type="button"
              className="ml-4 flex items-center gap-2 px-5 py-2.5 bg-indigo-500 text-white rounded-full text-xs font-black uppercase tracking-widest hover:bg-indigo-600 transition-all shadow-[0_0_20px_rgba(79,70,229,0.3)] active:scale-95 cursor-pointer"
            >
              <Plus size={14} />
              Manual Entry
            </button>
          )}
          {activeTab === 'debts' && (
            <button
              onClick={() => setShowSettlementModal(true)}
              type="button"
              className="ml-4 flex items-center gap-2 px-5 py-2.5 bg-indigo-500 text-white rounded-full text-xs font-black uppercase tracking-widest hover:bg-indigo-600 transition-all shadow-[0_0_20px_rgba(79,70,229,0.3)] active:scale-95 cursor-pointer"
            >
              <PlusCircle size={14} />
              Record Settlement
            </button>
          )}
        </div>
      </header>

      <main
        className="max-w-full mx-auto px-6 md:px-12 py-12 relative z-10 touch-pan-y"
        onTouchStart={onSwipeStart}
        onTouchMove={onSwipeMove}
        onTouchEnd={onSwipeEnd}
      >
        <AnimatePresence mode="wait" onExitComplete={() => setIsTabSwitching(false)}>
          {activeTab === 'dashboard' && (
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {[
                  { icon: Users, label: "Total Players", value: players.length, color: "text-blue-400" },
                  { icon: History, label: "Total Sessions", value: sessions.length, color: "text-purple-400" },
                  { icon: Trophy, label: "Top Performer", value: players[0]?.name || '-', color: "text-emerald-400" }
                ].map((stat, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.1 }}
                    className="bg-white/5 backdrop-blur-md p-8 rounded-3xl border border-white/10 shadow-2xl group hover:border-white/20 transition-all"
                  >
                    <div className="flex items-center gap-3 text-zinc-500 mb-4">
                      <stat.icon size={18} className={stat.color} />
                      <span className="text-[10px] font-black uppercase tracking-[0.2em]">{stat.label}</span>
                    </div>
                    <div className={cn("text-4xl font-black tracking-tighter", stat.color === "text-emerald-400" ? "text-emerald-400" : "text-white")}>
                      {stat.value}
                    </div>
                  </motion.div>
                ))}
              </div>

              <div className="bg-black/40 backdrop-blur-xl rounded-[2rem] border border-white/10 shadow-2xl overflow-hidden">
                <div className="px-4 md:px-8 py-6 border-b border-white/5 flex items-center justify-between bg-white/5">
                  <h2 className="font-black text-xl uppercase italic tracking-tighter">Leaderboard</h2>
                  <div className="flex items-center gap-2 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">
                    <TrendingUp size={12} className="text-emerald-500" />
                    Live Rankings
                  </div>
                </div>
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="text-zinc-500 text-[10px] font-black uppercase tracking-[0.2em]">
                        <th className="px-8 py-5">Rank</th>
                        <th className="px-8 py-5">Player</th>
                        <th className="px-8 py-5 text-right">Net Profit/Loss</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {players.map((player, idx) => (
                        <motion.tr
                          key={player.id}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: idx * 0.05 }}
                          onClick={() => handlePlayerClick(player)}
                          onKeyDown={(e) => handlePlayerKey(e, player)}
                          role="button"
                          tabIndex={0}
                          aria-label={`View P/L history for ${player.name}`}
                          className="hover:bg-white/5 transition-colors group cursor-pointer focus:outline-none focus:bg-white/5"
                        >
                          <td className="px-8 py-6">
                            <div className={cn(
                              "w-8 h-8 rounded-lg flex items-center justify-center text-xs font-black",
                              idx === 0 ? "bg-yellow-500 text-black shadow-[0_0_15px_rgba(234,179,8,0.3)]" :
                                idx === 1 ? "bg-zinc-300 text-black" :
                                  idx === 2 ? "bg-orange-600 text-white" :
                                    "bg-white/10 text-zinc-400"
                            )}>
                              {idx + 1}
                            </div>
                          </td>
                          <td className="px-8 py-6">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-white/10 to-white/5 flex items-center justify-center font-black text-xs border border-white/10">
                                {player.name.charAt(0).toUpperCase()}
                              </div>
                              <span className="font-bold text-lg tracking-tight">{player.name}</span>
                            </div>
                          </td>
                          <td className={cn(
                            "px-8 py-6 text-right font-mono text-xl font-black tracking-tighter",
                            player.total_profit >= 0 ? "text-emerald-400" : "text-rose-500"
                          )}>
                            <div className="flex items-center justify-end gap-2">
                              {player.total_profit >= 0 ? <ArrowUpRight size={20} /> : <ArrowDownRight size={20} />}
                              {player.total_profit >= 0 ? '+' : '-'}₹{Math.abs(player.total_profit).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </div>
                          </td>
                        </motion.tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <ul className="md:hidden divide-y divide-white/5">
                  {players.map((player, idx) => (
                    <motion.li
                      key={player.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: idx * 0.05 }}
                      onClick={() => handlePlayerClick(player)}
                      onKeyDown={(e) => handlePlayerKey(e, player)}
                      role="button"
                      tabIndex={0}
                      aria-label={`View P/L history for ${player.name}`}
                      className="px-4 py-4 hover:bg-white/5 transition-colors cursor-pointer focus:outline-none focus:bg-white/5"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={cn(
                          "w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-black shrink-0",
                          idx === 0 ? "bg-yellow-500 text-black shadow-[0_0_15px_rgba(234,179,8,0.3)]" :
                            idx === 1 ? "bg-zinc-300 text-black" :
                              idx === 2 ? "bg-orange-600 text-white" :
                                "bg-white/10 text-zinc-400"
                        )}>
                          {idx + 1}
                        </div>
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-white/10 to-white/5 flex items-center justify-center font-black text-[11px] border border-white/10 shrink-0">
                          {player.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="font-bold text-sm tracking-tight truncate min-w-0 flex-1">{player.name}</span>
                      </div>
                      <div className={cn(
                        "mt-2 text-right font-mono text-2xl font-black tracking-tighter flex items-center justify-end gap-1.5",
                        player.total_profit >= 0 ? "text-emerald-400" : "text-rose-500"
                      )}>
                        {player.total_profit >= 0 ? <ArrowUpRight size={20} /> : <ArrowDownRight size={20} />}
                        {player.total_profit >= 0 ? '+' : '-'}₹{Math.abs(player.total_profit).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </div>
                    </motion.li>
                  ))}
                </ul>
              </div>
            </motion.div>
          )}

          {activeTab === 'sessions' && (
            <motion.div
              key="sessions"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              <section className="bg-sky-500/5 border border-sky-500/20 rounded-[2rem] p-6 md:p-8 space-y-6">
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-2xl bg-sky-500/10 text-sky-400 flex items-center justify-center shrink-0">
                    <Link2 size={22} />
                  </div>
                  <div>
                    <h2 className="font-black text-xl uppercase italic tracking-tighter text-white">
                      Track a PokerNow game
                    </h2>
                    <p className="text-xs text-zinc-500 mt-1">
                      Save the link at the start. At the end, P/L is fetched automatically
                      and the Game Log calculates dealt-in time.
                    </p>
                  </div>
                </div>

                <form
                  onSubmit={startPokerNowTracking}
                  className="grid grid-cols-1 md:grid-cols-[1fr_0.7fr_auto] gap-3"
                >
                  <input
                    type="url"
                    required
                    value={pokerNowLink}
                    onChange={(event) => setPokerNowLink(event.target.value)}
                    placeholder="https://www.pokernow.com/games/pgl..."
                    className="w-full px-4 py-3.5 bg-black/30 border border-white/10 rounded-xl outline-none focus:ring-2 focus:ring-sky-500 text-sm text-white"
                  />
                  <input
                    type="text"
                    value={pokerNowNote}
                    onChange={(event) => setPokerNowNote(event.target.value)}
                    placeholder="Session name (optional)"
                    className="w-full px-4 py-3.5 bg-black/30 border border-white/10 rounded-xl outline-none focus:ring-2 focus:ring-sky-500 text-sm text-white"
                  />
                  <button
                    type="submit"
                    disabled={isStartingPokerNow || !pokerNowLink.trim()}
                    className="px-5 py-3.5 bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-slate-950 rounded-xl font-black text-xs uppercase tracking-wider transition-all"
                  >
                    {isStartingPokerNow ? 'Starting…' : 'Start tracking'}
                  </button>
                </form>

                {pokerNowTrackers.length > 0 && (
                  <div className="space-y-3">
                    {pokerNowTrackers.map((tracker) => (
                      <div
                        key={tracker.id}
                        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 bg-black/20 border border-sky-500/10 rounded-2xl"
                      >
                        <div>
                          <p className="font-black text-zinc-200">
                            {tracker.note || tracker.gameId}
                          </p>
                          <p className="text-[10px] text-zinc-500 mt-1">
                            Tracking since{' '}
                            {new Date(tracker.startedAt).toLocaleString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                              day: '2-digit',
                              month: 'short',
                            })}
                          </p>
                        </div>
                        <label
                          className={`px-5 py-3 rounded-xl text-xs font-black uppercase tracking-wider cursor-pointer transition-all ${
                            finishingPokerNowId === tracker.id
                              ? 'bg-zinc-700 text-zinc-400 pointer-events-none'
                              : 'bg-emerald-500 text-slate-950 hover:bg-emerald-400'
                          }`}
                        >
                          {finishingPokerNowId === tracker.id
                            ? 'Finalizing…'
                            : 'Finish with Game Log'}
                          <input
                            type="file"
                            accept=".csv,text/csv"
                            className="hidden"
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              if (file) void finalizePokerNowTracking(tracker, file);
                              event.target.value = '';
                            }}
                          />
                        </label>
                      </div>
                    ))}
                  </div>
                )}

                {pokerNowError && (
                  <p className="text-xs font-bold text-rose-400 flex items-center gap-2">
                    <AlertCircle size={15} /> {pokerNowError}
                  </p>
                )}
                <p className="text-[10px] text-zinc-600">
                  Two app requests per game: one ledger baseline at start and one final
                  ledger snapshot at close. The Game Log stays in your browser.
                </p>
              </section>

              {/* Upload Area */}
              <div
                {...getRootProps()}
                className={cn(
                  "border-2 border-dashed rounded-[2rem] p-16 text-center transition-all cursor-pointer relative overflow-hidden group",
                  isDragActive ? "border-indigo-500 bg-indigo-500/10" : "border-white/10 bg-white/5 hover:border-white/20",
                  isUploading && "opacity-50 pointer-events-none"
                )}
              >
                <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/5 to-purple-600/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                <input {...getInputProps()} />
                <div className="flex flex-col items-center gap-6 relative z-10">
                  <div className="w-20 h-20 bg-white/10 text-white rounded-3xl flex items-center justify-center shadow-2xl border border-white/10 group-hover:scale-110 transition-transform">
                    {isUploading ? (
                      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-white" />
                    ) : (
                      <Upload size={32} />
                    )}
                  </div>
                  <div>
                    <p className="font-black text-2xl uppercase tracking-tighter italic">Import Session Data</p>
                    <p className="text-zinc-500 text-xs font-bold uppercase tracking-widest mt-2">
                      Screenshot, PDF, Excel or PokerNow CSV
                    </p>
                    <p className="text-zinc-600 text-[10px] mt-2">
                      Drop a PokerNow ledger and Game Log together to include attendance.
                    </p>
                  </div>
                </div>
              </div>

              {uploadError && (
                <div className="flex items-center gap-3 px-6 py-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl text-rose-400 text-sm font-bold">
                  <AlertCircle size={18} className="shrink-0" />
                  {uploadError}
                </div>
              )}

              {/* Session History */}
              <div className="space-y-6">
                <div className="flex items-center justify-between px-4">
                  <h2 className="font-black text-xl uppercase italic tracking-tighter">Session Logs</h2>
                  <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-[0.2em]">History</div>
                </div>
                {sessions.map((session, sIdx) => (
                  <motion.div
                    key={session.id}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: sIdx * 0.1 }}
                    className="bg-black/40 backdrop-blur-xl rounded-3xl border border-white/10 shadow-2xl overflow-hidden group"
                  >
                    <div className="px-4 md:px-8 py-5 border-b border-white/5 flex items-center bg-white/5">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-xl bg-white/5 flex flex-col items-center justify-center border border-white/10">
                          <span className="text-[10px] font-black text-zinc-500 uppercase">{monthName(session.date.split('-')[1])}</span>
                          <span className="text-lg font-black leading-none">{session.date.split('-')[2]}</span>
                        </div>
                        <div>
                          <div className="font-black text-lg tracking-tight uppercase italic">{session.note || 'Untitled Session'}</div>
                          <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">{session.date}</div>
                        </div>
                      </div>
                    </div>
                    <div className="p-8">
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-8">
                        {session.results.map((res, i) => (
                          <div key={i} className="flex flex-col gap-1">
                            <span className="text-[10px] text-zinc-500 font-black uppercase tracking-[0.2em]">{res.name}</span>
                            <span className={cn(
                              "font-mono text-lg font-black tracking-tighter",
                              res.amount >= 0 ? "text-emerald-400" : "text-rose-500"
                            )}>
                              {res.amount >= 0 ? '+' : '-'}₹{Math.abs(res.amount).toFixed(2)}
                            </span>
                          </div>
                        ))}
                      </div>
                      {(session.attendance ?? []).length > 0 && (
                        <div className="mt-8 pt-6 border-t border-white/5">
                          <div className="flex items-center justify-between mb-4">
                            <h3 className="text-[10px] font-black text-sky-400 uppercase tracking-[0.2em] flex items-center gap-2">
                              <Clock size={13} /> PokerNow dealt-in time
                            </h3>
                            <span className="text-[9px] font-bold text-zinc-600 uppercase">
                              Evidence only · unscored
                            </span>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {(session.attendance ?? []).map((entry) => (
                              <div
                                key={entry.externalId}
                                className="flex items-center justify-between gap-4 px-4 py-3 bg-sky-500/5 border border-sky-500/10 rounded-xl"
                              >
                                <div>
                                  <p className="text-xs font-black text-zinc-200">{entry.name}</p>
                                  <p className="text-[9px] text-zinc-500 mt-1">
                                    {new Date(entry.joinedAt).toLocaleTimeString([], {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                    })}{' '}
                                    –{' '}
                                    {new Date(entry.leftAt).toLocaleTimeString([], {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                    })}
                                  </p>
                                </div>
                                <div className="text-right">
                                  <p className="text-sm font-black text-sky-400">
                                    {Math.round(entry.durationMinutes)} min
                                  </p>
                                  <p className="text-[8px] font-black text-zinc-600 uppercase">
                                    {entry.handCount} hands · {entry.confidence}
                                  </p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}

          {activeTab === 'players' && (
            <motion.div
              key="players"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              <div className="bg-black/40 backdrop-blur-xl rounded-[2rem] border border-white/10 shadow-2xl overflow-hidden">
                <div className="px-4 md:px-8 py-6 border-b border-white/5 bg-white/5 flex items-center justify-between">
                  <div>
                    <h2 className="font-black text-xl uppercase italic tracking-tighter">Player Management</h2>
                    <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-[0.2em] mt-1">Manage aliases to prevent duplicate players</p>
                  </div>
                  {mergeSource && (
                    <button
                      onClick={() => setMergeSource(null)}
                      className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 text-amber-400 rounded-full text-[10px] font-black uppercase tracking-widest border border-amber-500/20"
                    >
                      <X size={12} />
                      Cancel Merge
                    </button>
                  )}
                </div>

                {aliasError && (
                  <div className="mx-8 mt-6 flex items-center gap-3 px-6 py-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl text-rose-400 text-sm font-bold">
                    <AlertCircle size={18} className="shrink-0" />
                    {aliasError}
                    <button onClick={() => setAliasError(null)} className="ml-auto"><X size={16} /></button>
                  </div>
                )}

                {mergeSource && (
                  <div className="mx-8 mt-6 flex items-center gap-3 px-6 py-4 bg-amber-500/10 border border-amber-500/20 rounded-2xl text-amber-300 text-sm font-bold">
                    <Merge size={18} className="shrink-0" />
                    Select the target player to merge "{playersWithAliases.find(p => p.id === mergeSource)?.name}" into
                  </div>
                )}

                <div className="p-8 space-y-6">
                  {playersWithAliases.map((player, pIdx) => (
                    <motion.div
                      key={player.id}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: pIdx * 0.05 }}
                      className={cn(
                        "p-6 rounded-2xl border transition-all",
                        mergeSource === player.id
                          ? "bg-amber-500/10 border-amber-500/30"
                          : mergeSource
                            ? "bg-white/5 border-white/10 hover:border-indigo-500/50 cursor-pointer"
                            : "bg-white/5 border-white/10"
                      )}
                      onClick={() => {
                        if (mergeSource && mergeSource !== player.id) {
                          handleMergePlayer(mergeSource, player.id);
                        }
                      }}
                    >
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-white/10 to-white/5 flex items-center justify-center font-black text-xs border border-white/10">
                            {player.name.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <span className="font-black text-lg tracking-tight">{player.name}</span>
                            <div className={cn(
                              "font-mono text-sm font-bold",
                              Number(player.session_profit) >= 0 ? "text-emerald-400" : "text-rose-500"
                            )}>
                              {Number(player.session_profit) >= 0 ? '+' : '-'}₹{Math.abs(Number(player.session_profit)).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </div>
                          </div>
                        </div>
                        {!mergeSource && (
                          <button
                            onClick={() => setMergeSource(player.id)}
                            title="Merge this player into another"
                            className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-zinc-400 hover:text-amber-400 hover:bg-amber-400/10 rounded-lg border border-white/5 hover:border-amber-400/20 transition-all"
                          >
                            <Merge size={12} />
                            Merge
                          </button>
                        )}
                        {mergeSource && mergeSource !== player.id && (
                          <span className="text-[10px] font-black uppercase tracking-widest text-indigo-400">
                            Click to merge here
                          </span>
                        )}
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center gap-2 text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em]">
                          <Link2 size={12} />
                          Aliases
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {player.aliases.map(a => (
                            <span
                              key={a.id}
                              className="flex items-center gap-2 px-3 py-1.5 bg-indigo-500/10 text-indigo-300 rounded-lg text-xs font-bold border border-indigo-500/20"
                            >
                              {a.alias}
                              <button
                                onClick={(e) => { e.stopPropagation(); handleRemoveAlias(a.id); }}
                                className="hover:text-rose-400 transition-colors"
                              >
                                <X size={12} />
                              </button>
                            </span>
                          ))}
                          {player.aliases.length === 0 && (
                            <span className="text-xs text-zinc-600 italic">No aliases yet</span>
                          )}
                        </div>
                        <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="text"
                            placeholder="Add alias (e.g. Thor, Odin, Rodagaleme, Deuces)"
                            value={newAliasInputs[player.id] || ''}
                            onChange={(e) => setNewAliasInputs({ ...newAliasInputs, [player.id]: e.target.value })}
                            onKeyDown={(e) => e.key === 'Enter' && handleAddAlias(player.id)}
                            className="flex-1 px-4 py-2 bg-white/5 border border-white/10 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none text-white text-sm"
                          />
                          <button
                            onClick={() => handleAddAlias(player.id)}
                            className="px-4 py-2 bg-indigo-500/20 text-indigo-300 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-indigo-500/30 transition-all border border-indigo-500/20"
                          >
                            Add
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  ))}

                  {playersWithAliases.length === 0 && (
                    <div className="text-center py-20 text-zinc-600">
                      <div className="w-20 h-20 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-6 border border-white/10">
                        <Users size={40} className="text-zinc-600" />
                      </div>
                      <p className="font-black uppercase tracking-widest text-sm">No players yet. Create a session first.</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="bg-black/40 backdrop-blur-xl rounded-[2rem] border border-white/10 shadow-2xl p-8">
                <h3 className="font-black text-lg uppercase italic tracking-tighter mb-4">How Aliases Work</h3>
                <div className="space-y-3 text-sm text-zinc-400">
                  <p><span className="text-white font-bold">Add aliases</span> — If "John" also plays as "thor" or "J-Money", add those as aliases.</p>
                  <p><span className="text-white font-bold">Auto-resolve</span> — When importing sessions, any alias is automatically mapped to the real player.</p>
                  <p><span className="text-white font-bold">Merge players</span> — If duplicates already exist, merge them to combine all their session data.</p>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'debts' && (
            <motion.div
              key="debts"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              <div className="bg-black/40 backdrop-blur-xl rounded-[2rem] border border-white/10 shadow-2xl overflow-hidden relative z-20">
                <div className="px-4 md:px-8 py-6 border-b border-white/5 bg-white/5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 relative z-30">
                  <div>
                    <h2 className="font-black text-xl uppercase italic tracking-tighter">Settlement Plan</h2>
                    <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-[0.2em] mt-1">Optimized Transaction Matrix</p>
                  </div>
                </div>
                <div className="p-8 space-y-6">
                  {calculateDebts().length > 0 ? (
                    calculateDebts().map((debt, i) => (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: i * 0.1 }}
                        className="flex flex-col sm:flex-row sm:items-center justify-between p-5 md:p-6 bg-white/5 rounded-2xl border border-white/10 group hover:border-white/20 transition-all gap-3"
                      >
                        <div className="flex items-center gap-4 md:gap-8">
                          <div className="flex flex-col">
                            <span className="text-[10px] text-zinc-500 font-black uppercase tracking-[0.2em] mb-1">Debtor</span>
                            <span className="font-black text-base md:text-lg tracking-tight">{debt.from}</span>
                          </div>
                          <div className="flex flex-col items-center">
                            <div className="h-px w-8 md:w-16 bg-gradient-to-r from-transparent via-white/20 to-transparent relative">
                              <ChevronRight size={16} className="absolute -right-2 -top-2 text-white/40" />
                            </div>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-[10px] text-zinc-500 font-black uppercase tracking-[0.2em] mb-1">Recipient</span>
                            <span className="font-black text-base md:text-lg tracking-tight">{debt.to}</span>
                          </div>
                        </div>
                        <div className="text-2xl md:text-3xl font-mono font-black text-white tracking-tighter">
                          ₹{debt.amount.toFixed(2)}
                        </div>
                      </motion.div>
                    ))
                  ) : (
                    <div className="text-center py-20 text-zinc-600">
                      <div className="w-20 h-20 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-6 border border-white/10">
                        <Check size={40} className="text-emerald-500" />
                      </div>
                      <p className="font-black uppercase tracking-widest text-sm">All accounts are settled</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Settlement History */}
              <div className="space-y-6">
                <div className="flex items-center justify-between px-4">
                  <h2 className="font-black text-xl uppercase italic tracking-tighter">Settlement Logs</h2>
                  <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-[0.2em]">History</div>
                </div>
                {settlements.map((settlement, sIdx) => (
                  <motion.div
                    key={settlement.id}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: sIdx * 0.1 }}
                    className="bg-black/40 backdrop-blur-xl rounded-3xl border border-white/10 shadow-2xl overflow-hidden group"
                  >
                    <div className="px-4 md:px-8 py-4 md:py-5 flex flex-col sm:flex-row sm:items-center gap-3">
                      <div className="flex items-center gap-3 sm:border-r sm:border-white/10 sm:pr-4">
                        <div className={cn(
                          "w-10 h-10 md:w-12 md:h-12 rounded-xl flex flex-col items-center justify-center border shrink-0",
                          settlement.status === 'voided' ? "bg-white/5 border-rose-500/20 opacity-50" : "bg-white/5 border-white/10"
                        )}>
                          <span className="text-[9px] md:text-[10px] font-black text-zinc-500 uppercase">{monthName(settlement.date.split('-')[1])}</span>
                          <span className="text-base md:text-lg font-black leading-none">{settlement.date.split('-')[2]}</span>
                        </div>
                        <div className="flex flex-1 items-center gap-3 sm:hidden">
                          <div className={cn("flex flex-col", settlement.status === 'voided' && "opacity-50")}>
                            <span className="font-black text-sm">{settlement.payer}</span>
                          </div>
                          <ChevronRight size={14} className="text-white/40 shrink-0" />
                          <div className={cn("flex flex-col", settlement.status === 'voided' && "opacity-50")}>
                            <span className="font-black text-sm">{settlement.payee}</span>
                          </div>
                          <span className={cn("font-mono text-sm font-black ml-auto", settlement.status === 'voided' ? "text-zinc-500 line-through" : "text-emerald-400")}>
                            ₹{Number(settlement.amount).toFixed(0)}
                          </span>
                          {settlement.status === 'voided' && <span className="text-rose-500 text-[8px] font-black uppercase">Voided</span>}
                        </div>
                      </div>
                      <div className="hidden sm:flex flex-1 items-center justify-between pl-2">
                        <div className="flex items-center gap-4 w-full">
                          <div className={cn("flex flex-col flex-1", settlement.status === 'voided' && "opacity-50")}>
                            <span className="text-[10px] text-zinc-500 font-black uppercase tracking-[0.2em]">Payer</span>
                            <span className={cn("font-black text-lg", settlement.status === 'voided' && "line-through text-zinc-500")}>
                              {settlement.payer}
                            </span>
                          </div>
                          <ChevronRight size={16} className="text-white/40" />
                          <div className={cn("flex flex-col flex-1", settlement.status === 'voided' && "opacity-50")}>
                            <span className="text-[10px] text-zinc-500 font-black uppercase tracking-[0.2em]">Payee</span>
                            <span className={cn("font-black text-lg", settlement.status === 'voided' && "line-through text-zinc-500")}>
                              {settlement.payee}
                            </span>
                          </div>
                          <div className="flex flex-col flex-1 text-right">
                            <span className="text-[10px] text-zinc-500 font-black uppercase tracking-[0.2em]">Amount</span>
                            <span className="font-mono text-lg font-black text-emerald-400 relative">
                              <span className={cn(settlement.status === 'voided' && "line-through text-zinc-500")}>
                                ₹{Number(settlement.amount).toFixed(2)}
                              </span>
                              {settlement.status === 'voided' && (
                                <span className="absolute -top-4 -right-2 bg-rose-500/10 text-rose-500 text-[8px] font-black tracking-widest px-2 py-0.5 rounded uppercase">
                                  Voided
                                </span>
                              )}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="hidden sm:flex flex-col gap-1 ml-4">
                        {settlement.status !== 'voided' ? (
                          <button
                            onClick={() => handleDeleteSettlement(settlement.id)}
                            title="Undo this settlement"
                            className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-zinc-400 hover:text-amber-400 hover:bg-amber-400/10 rounded-lg border border-white/5 hover:border-amber-400/20 transition-all"
                          >
                            Undo
                          </button>
                        ) : (
                          <button
                            onClick={() => handleRestoreSettlement(settlement.id)}
                            title="Restore this settlement"
                            className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-zinc-400 hover:text-emerald-400 hover:bg-emerald-400/10 rounded-lg border border-white/5 hover:border-emerald-400/20 transition-all"
                          >
                            Restore
                          </button>
                        )}
                      </div>
                    </div>
                  </motion.div>
                ))}
                {settlements.length === 0 && (
                  <div className="text-center py-10 text-zinc-600 bg-black/40 backdrop-blur-xl rounded-3xl border border-white/10">
                    <p className="font-black uppercase tracking-widest text-sm text-zinc-500">No settlements recorded yet</p>
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {activeTab === 'rules' && (
            <motion.div
              key="rules"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              {/* Hero Banner */}
              <div className="bg-gradient-to-br from-indigo-600/20 via-purple-600/10 to-black/40 backdrop-blur-xl rounded-[2rem] border border-indigo-500/20 shadow-2xl overflow-hidden p-10 text-center relative">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(79,70,229,0.15),transparent_70%)]" />
                <div className="relative z-10">
                  <div className="text-6xl mb-4">🎲</div>
                  <h2 className="font-black text-3xl uppercase italic tracking-tighter bg-gradient-to-r from-white via-indigo-200 to-purple-300 bg-clip-text text-transparent">
                    Online House Poker Room
                  </h2>
                  <p className="text-zinc-400 text-sm font-bold uppercase tracking-[0.3em] mt-3">Official Rules & Etiquette</p>
                </div>
              </div>

              {/* Rules Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Minimum Game Time */}
                <motion.div
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.1 }}
                  className="bg-black/40 backdrop-blur-xl rounded-[2rem] border border-white/10 shadow-2xl p-8 group hover:border-amber-500/30 transition-all"
                >
                  <div className="flex items-center gap-4 mb-6">
                    <div className="w-14 h-14 bg-amber-500/10 rounded-2xl flex items-center justify-center border border-amber-500/20 group-hover:scale-110 transition-transform">
                      <Clock size={28} className="text-amber-400" />
                    </div>
                    <div>
                      <h3 className="font-black text-lg uppercase italic tracking-tighter">Minimum Game Time</h3>
                      <p className="text-[10px] text-amber-400 font-bold uppercase tracking-[0.2em]">3 Hour Commitment</p>
                    </div>
                  </div>
                  <div className="space-y-3 text-sm text-zinc-400">
                    <p>All players must commit to a <span className="text-white font-bold">minimum of 3 hours</span> of gameplay once seated at the table.</p>
                    <p>No player may go offline or leave the game in between, except as permitted under the Loss Exit Rule.</p>
                    <p className="text-amber-300/80">If you have to go offline, you need to increase your playtime by the same amount.</p>
                  </div>
                </motion.div>

                {/* Call Announcements */}
                <motion.div
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.2 }}
                  className="bg-black/40 backdrop-blur-xl rounded-[2rem] border border-white/10 shadow-2xl p-8 group hover:border-blue-500/30 transition-all"
                >
                  <div className="flex items-center gap-4 mb-6">
                    <div className="w-14 h-14 bg-blue-500/10 rounded-2xl flex items-center justify-center border border-blue-500/20 group-hover:scale-110 transition-transform">
                      <Megaphone size={28} className="text-blue-400" />
                    </div>
                    <div>
                      <h3 className="font-black text-lg uppercase italic tracking-tighter">Call Announcements</h3>
                      <p className="text-[10px] text-blue-400 font-bold uppercase tracking-[0.2em]">30 Min Notice</p>
                    </div>
                  </div>
                  <div className="space-y-3 text-sm text-zinc-400">
                    <p>Announcements for upcoming games or table openings will be made <span className="text-white font-bold">30 minutes</span> before the scheduled start time.</p>
                    <p>Stay tuned to the group for game calls and be ready to join on time.</p>
                  </div>
                </motion.div>

                {/* Games Offered */}
                <motion.div
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.3 }}
                  className="bg-black/40 backdrop-blur-xl rounded-[2rem] border border-white/10 shadow-2xl p-8 group hover:border-emerald-500/30 transition-all"
                >
                  <div className="flex items-center gap-4 mb-6">
                    <div className="w-14 h-14 bg-emerald-500/10 rounded-2xl flex items-center justify-center border border-emerald-500/20 group-hover:scale-110 transition-transform">
                      <Spade size={28} className="text-emerald-400" />
                    </div>
                    <div>
                      <h3 className="font-black text-lg uppercase italic tracking-tighter">Games Offered</h3>
                      <p className="text-[10px] text-emerald-400 font-bold uppercase tracking-[0.2em]">Round-Round Format</p>
                    </div>
                  </div>
                  <div className="space-y-3 text-sm text-zinc-400">
                    <p>The primary games spread in the house are:</p>
                    <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-xl p-4">
                      <p className="text-white font-black uppercase tracking-tight">Round-Round</p>
                      <p className="text-emerald-300/80 text-xs mt-1">Alternating between <span className="font-bold">Texas Hold'em (NLH)</span> and <span className="font-bold">Pot Limit Omaha (PLO)</span></p>
                    </div>
                  </div>
                </motion.div>

                {/* Play Plan */}
                <motion.div
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.4 }}
                  className="bg-black/40 backdrop-blur-xl rounded-[2rem] border border-white/10 shadow-2xl p-8 group hover:border-rose-500/30 transition-all"
                >
                  <div className="flex items-center gap-4 mb-6">
                    <div className="w-14 h-14 bg-rose-500/10 rounded-2xl flex items-center justify-center border border-rose-500/20 group-hover:scale-110 transition-transform">
                      <DoorOpen size={28} className="text-rose-400" />
                    </div>
                    <div>
                      <h3 className="font-black text-lg uppercase italic tracking-tighter">Play Plan</h3>
                      <p className="text-[10px] text-rose-400 font-bold uppercase tracking-[0.2em]">Coordinate, Don&apos;t Pressure</p>
                    </div>
                  </div>
                  <div className="space-y-3 text-sm text-zinc-400">
                    <p>Before play, choose a <span className="text-white font-bold">full-session, timed, or flexible</span> plan so the table can coordinate seats.</p>
                    <div className="bg-rose-500/5 border border-rose-500/10 rounded-xl p-4">
                      <p className="text-rose-300 font-bold text-xs">Plans never depend on winnings and never require anyone to continue playing or rebuy.</p>
                    </div>
                  </div>
                </motion.div>
              </div>

              {/* General Etiquette */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5 }}
                className="bg-black/40 backdrop-blur-xl rounded-[2rem] border border-white/10 shadow-2xl p-8 group hover:border-purple-500/30 transition-all"
              >
                <div className="flex items-center gap-4 mb-6">
                  <div className="w-14 h-14 bg-purple-500/10 rounded-2xl flex items-center justify-center border border-purple-500/20 group-hover:scale-110 transition-transform">
                    <Handshake size={28} className="text-purple-400" />
                  </div>
                  <div>
                    <h3 className="font-black text-lg uppercase italic tracking-tighter">General Etiquette</h3>
                    <p className="text-[10px] text-purple-400 font-bold uppercase tracking-[0.2em]">Play Fair, Play Fun</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                  {[
                    "Respect all players at the table",
                    "No slow-rolling or excessive celebration",
                    "Keep chat clean and friendly",
                    "Settle debts promptly after the session",
                    "No coaching or revealing hands during play",
                    "Be ready when it's your turn to act"
                  ].map((rule, i) => (
                    <div key={i} className="flex items-start gap-3 p-3 bg-white/5 rounded-xl border border-white/5">
                      <div className="w-6 h-6 bg-purple-500/20 rounded-lg flex items-center justify-center shrink-0 mt-0.5">
                        <Check size={14} className="text-purple-400" />
                      </div>
                      <span className="text-zinc-300">{rule}</span>
                    </div>
                  ))}
                </div>
              </motion.div>
            </motion.div>
          )}

          {activeTab === 'livePlay' && (
            <motion.div
              key="livePlay"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
            >
              {renderLiveSection()}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Confirmation Modal */}
      <AnimatePresence>
        {showConfirmModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowConfirmModal(false)}
              className="absolute inset-0 bg-black/80 backdrop-blur-md"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 40 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 40 }}
              className="bg-zinc-900 w-full max-w-2xl rounded-[2.5rem] shadow-[0_0_50px_rgba(0,0,0,0.5)] border border-white/10 relative z-10 overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-8 border-b border-white/5 flex items-center justify-between bg-white/5">
                <div>
                  <h3 className="text-2xl font-black uppercase italic tracking-tighter">{isManualEntry ? 'New Session' : 'Verify Results'}</h3>
                  <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-[0.2em] mt-1">{isManualEntry ? 'Manual Entry' : 'AI Extraction Review'}</p>
                </div>
                <button onClick={() => setShowConfirmModal(false)} className="w-10 h-10 flex items-center justify-center hover:bg-white/10 rounded-full transition-colors">
                  <X size={24} />
                </button>
              </div>

              <div className="p-8 overflow-y-auto space-y-8">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em]">Session Date</label>
                    <input
                      type="date"
                      value={sessionDate}
                      onChange={(e) => setSessionDate(e.target.value)}
                      className="w-full px-5 py-3 bg-white/5 border border-white/10 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none text-white font-bold"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em]">Session Note</label>
                    <input
                      type="text"
                      placeholder="e.g. High Stakes Night"
                      value={sessionNote}
                      onChange={(e) => setSessionNote(e.target.value)}
                      className="w-full px-5 py-3 bg-white/5 border border-white/10 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none text-white font-bold"
                    />
                  </div>
                </div>

                {pendingAttendance.length > 0 && (
                  <section className="space-y-4 p-5 rounded-2xl bg-sky-500/5 border border-sky-500/20">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h4 className="text-sm font-black text-sky-400 uppercase tracking-wider">
                          PokerNow dealt-in time found
                        </h4>
                        <p className="text-[10px] text-zinc-500 mt-1">
                          Parsed locally from completed hands in the Game Log. With no
                          pre-session Play Plan, these times are evidence only and stay unscored.
                        </p>
                      </div>
                      <span className="text-[9px] font-black text-sky-400 bg-sky-500/10 px-3 py-1 rounded-full whitespace-nowrap">
                        {pendingAttendance.length} players
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {pendingAttendance.map((entry) => (
                        <div
                          key={entry.externalId}
                          className="flex items-center justify-between gap-3 bg-black/20 px-3 py-2.5 rounded-xl"
                        >
                          <span className="text-xs font-bold text-zinc-300 truncate">
                            {entry.name}
                          </span>
                          <span className="text-[9px] font-black text-sky-400 whitespace-nowrap">
                            {Math.round(entry.durationMinutes)} min · {entry.handCount} hands
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <div className="space-y-4">
                  <div className="flex items-center justify-between px-2 text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em]">
                    <span>Player Identity</span>
                    <span>Profit / Loss</span>
                  </div>
                  <div className="space-y-3">
                    {pendingResults.map((result, idx) => (
                      <motion.div
                        key={idx}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: idx * 0.05 }}
                        className="flex items-center gap-4"
                      >
                        <input
                          type="text"
                          value={result.name}
                          onChange={(e) => updatePendingResult(idx, 'name', e.target.value)}
                          className="flex-1 px-5 py-3 bg-white/5 border border-white/10 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none text-white font-black italic tracking-tight"
                        />
                        <div className="relative w-40">
                          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 font-mono font-bold">₹</span>
                          <input
                            type="number"
                            step="any"
                            value={result.amount}
                            onChange={(e) => updatePendingResult(idx, 'amount', e.target.value === '' ? 0 : parseFloat(e.target.value))}
                            className="w-full pl-8 pr-5 py-3 bg-white/5 border border-white/10 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none text-white font-mono font-black text-right"
                          />
                        </div>
                        <button
                          onClick={() => setPendingResults(pendingResults.filter((_, i) => i !== idx))}
                          className="w-12 h-12 flex items-center justify-center text-zinc-600 hover:text-rose-500 hover:bg-rose-500/10 rounded-2xl transition-all"
                        >
                          <Trash2 size={20} />
                        </button>
                      </motion.div>
                    ))}
                  </div>
                  <button
                    onClick={() => setPendingResults([...pendingResults, { name: '', amount: 0 }])}
                    className="w-full py-4 border-2 border-dashed border-white/10 rounded-2xl text-zinc-500 hover:text-white hover:border-white/20 hover:bg-white/5 transition-all flex items-center justify-center gap-2 text-[10px] font-black uppercase tracking-[0.2em]"
                  >
                    <PlusCircle size={16} />
                    Add Entry
                  </button>
                </div>
              </div>

              {(() => {
                const total = pendingResults.reduce((sum, r) => sum + (r.amount || 0), 0);
                const balanced = Math.abs(total) < 0.01;
                return (
                  <div className="p-8 bg-white/5 border-t border-white/5 space-y-4">
                    <div className={cn(
                      "flex items-center justify-between px-6 py-3 rounded-2xl border text-sm font-bold",
                      balanced
                        ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                        : "bg-rose-500/10 border-rose-500/20 text-rose-400"
                    )}>
                      <span className="text-[10px] font-black uppercase tracking-[0.2em]">Session Balance</span>
                      <span className="font-mono font-black text-lg">
                        {balanced ? 'Balanced' : `${total >= 0 ? '+' : '-'}₹${Math.abs(total).toFixed(2)} off`}
                      </span>
                    </div>
                    <div className="flex gap-4">
                      <button
                        onClick={() => setShowConfirmModal(false)}
                        className="flex-1 py-4 bg-transparent border border-white/10 rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-white/5 transition-all active:scale-95"
                      >
                        Discard
                      </button>
                      <button
                        onClick={handleSaveSession}
                        disabled={!balanced || isSaving}
                        className={cn(
                          "flex-1 py-4 rounded-2xl font-black uppercase tracking-widest text-xs transition-all active:scale-95",
                          balanced && !isSaving
                            ? "bg-white text-black hover:bg-zinc-200 shadow-[0_0_30px_rgba(255,255,255,0.1)]"
                            : "bg-zinc-700 text-zinc-500 cursor-not-allowed"
                        )}
                      >
                        {isSaving ? 'Saving...' : 'Finalize Session'}
                      </button>
                    </div>
                  </div>
                );
              })()}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Settlement Modal */}
      {showSettlementModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/80 backdrop-blur-md"
            onClick={() => setShowSettlementModal(false)}
          />
          <div className="bg-zinc-900 w-full max-w-md rounded-[2rem] shadow-2xl border border-white/10 relative z-10 overflow-hidden">
            <div className="p-8 border-b border-white/5 flex items-center justify-between bg-white/5">
              <div>
                <h3 className="text-2xl font-black uppercase italic tracking-tighter">Record Settlement</h3>
                <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-[0.2em] mt-1">Log a payment between players</p>
              </div>
              <button onClick={() => setShowSettlementModal(false)} className="w-10 h-10 flex items-center justify-center hover:bg-white/10 rounded-full transition-colors">
                <X size={24} />
              </button>
            </div>

            <div className="p-8 space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em]">Payer (who paid)</label>
                <select
                  value={settlementData.payer}
                  onChange={(e) => setSettlementData({ ...settlementData, payer: e.target.value })}
                  className="w-full px-5 py-3 bg-zinc-800 border border-white/10 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none text-white font-bold"
                >
                  <option value="" style={{ background: '#27272a', color: '#fff' }}>Select player...</option>
                  {players.map(p => <option key={p.id} value={p.name} style={{ background: '#27272a', color: '#fff' }}>{p.name}</option>)}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em]">Payee (who received)</label>
                <select
                  value={settlementData.payee}
                  onChange={(e) => setSettlementData({ ...settlementData, payee: e.target.value })}
                  className="w-full px-5 py-3 bg-zinc-800 border border-white/10 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none text-white font-bold"
                >
                  <option value="" style={{ background: '#27272a', color: '#fff' }}>Select player...</option>
                  {players.map(p => <option key={p.id} value={p.name} style={{ background: '#27272a', color: '#fff' }}>{p.name}</option>)}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em]">Amount (₹)</label>
                <div className="relative">
                  <span className="absolute left-5 top-1/2 -translate-y-1/2 text-zinc-500 font-mono font-bold">₹</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={settlementData.amount}
                    onChange={(e) => setSettlementData({ ...settlementData, amount: e.target.value })}
                    className="w-full pl-10 pr-5 py-3 bg-white/5 border border-white/10 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none text-white font-mono font-black"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em]">Date</label>
                <input
                  type="date"
                  value={settlementData.date}
                  onChange={(e) => setSettlementData({ ...settlementData, date: e.target.value })}
                  className="w-full px-5 py-3 bg-white/5 border border-white/10 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none text-white font-bold"
                />
              </div>
            </div>

            <div className="p-8 bg-white/5 border-t border-white/5 flex gap-4">
              <button
                onClick={() => setShowSettlementModal(false)}
                className="flex-1 py-4 bg-transparent border border-white/10 rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-white/5 transition-all active:scale-95"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateSettlement}
                disabled={isSaving}
                className={cn(
                  "flex-1 py-4 rounded-2xl font-black uppercase tracking-widest text-xs transition-all active:scale-95",
                  isSaving
                    ? "bg-zinc-700 text-zinc-500 cursor-not-allowed"
                    : "bg-indigo-500 text-white hover:bg-indigo-600 shadow-[0_0_30px_rgba(79,70,229,0.3)]"
                )}
              >
                {isSaving ? 'Saving...' : 'Record Payment'}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedPlayer && (
        <PlayerHistoryModal
          playerId={selectedPlayer.id}
          playerName={selectedPlayer.name}
          onClose={() => setSelectedPlayer(null)}
        />
      )}
    </div>
  );
}
