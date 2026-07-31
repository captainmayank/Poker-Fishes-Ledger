import React, { useState, useEffect, useMemo } from 'react';
import {
  liveApi, LiveUser, LiveSession, LiveSessionPlayer as LiveSessionPlayerType, LiveBuyIn,
} from '../services/liveApi';
import { aggregateTableBuyIns, tablePot as computeTablePot, potShare } from '../lib/buyIns';
import {
  Clock, Wallet, CheckCircle, AlertCircle, Plus, Zap, History, DollarSign, ShieldCheck, Users, LogOut, LogIn,
  RefreshCw, CalendarClock,
} from 'lucide-react';

interface Props {
  user: LiveUser;
  sessionCode: string;
  navigate: (path: string) => void;
}

export default function LiveSessionPlayer({ user, sessionCode, navigate }: Props) {
  const [session, setSession]   = useState<LiveSession | null>(null);
  const [players, setPlayers]   = useState<LiveSessionPlayerType[]>([]);
  const [buyIns, setBuyIns]     = useState<LiveBuyIn[]>([]);
  const [allBuyIns, setAllBuyIns] = useState<LiveBuyIn[]>([]);
  const [amount, setAmount]     = useState('');
  const [isRequesting, setIsRequesting] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [outChips, setOutChips] = useState('');
  const [leaveError, setLeaveError] = useState('');
  const [hasLeft, setHasLeft] = useState(false);
  const [leavePending, setLeavePending] = useState(false);
  const [pendingOutChips, setPendingOutChips] = useState<number | undefined>(undefined);
  const [adjustPlan, setAdjustPlan] = useState(false);

  const refreshData = async () => {
    const data = await liveApi.getSession(sessionCode);
    if (!data) return;
    if (data.session.status === 'closed') {
      navigate(`settlement/${data.session.id}`);
      return;
    }
    setSession(data.session);
    setPlayers(data.players);
    setAllBuyIns(data.buyIns);
    setBuyIns(
      data.buyIns
        .filter((b) => b.userId === user.id)
        .sort((a, b) => b.timestamp - a.timestamp)
    );
    const me = data.players.find((p) => p.userId === user.id);
    setHasLeft(!!me?.leftAt);
    setLeavePending(!!me?.leavePending);
    setPendingOutChips(me?.pendingOutChips);
  };

  const tableBuyIns = useMemo(
    () => aggregateTableBuyIns(allBuyIns, players, user.id),
    [allBuyIns, players, user.id]
  );

  const tablePot = computeTablePot(tableBuyIns);

  useEffect(() => {
    refreshData();
  }, [sessionCode]);

  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session || !amount || parseFloat(amount) <= 0) return;
    const result = await liveApi.requestBuyIn(
      session.id,
      user.id,
      parseFloat(amount),
      user.authToken
    );
    if (!result.success || !result.buyIn) return;
    setBuyIns((current) => [result.buyIn!, ...current]);
    setAllBuyIns((current) => [...current, result.buyIn!]);
    setAmount('');
    setIsRequesting(false);
  };

  const handleLeave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;
    const chips = parseFloat(outChips);
    if (isNaN(chips) || chips < 0) {
      setLeaveError('Please enter a valid chip count (0 or more).');
      return;
    }
    setLeaveError('');
    const result = await liveApi.leaveSession(
      session.id,
      user.id,
      chips,
      adjustPlan
    );
    if (!result.success) {
      setLeaveError(result.error || 'Failed to leave table. Please try again.');
      return;
    }
    setLeavePending(true);
    setPendingOutChips(chips);
    setIsLeaving(false);
    setOutChips('');
    setAdjustPlan(false);
  };

  const handleCancelLeave = async () => {
    if (!session) return;
    const updated = await liveApi.rejectLeave(session.id, user.id);
    if (updated) {
      setLeavePending(false);
      setPendingOutChips(undefined);
    }
  };

  const handleRejoin = async () => {
    if (!session) return;
    const result = await liveApi.joinSession(session.sessionCode, user.id);
    if (result.success) {
      setHasLeft(false);
      await refreshData();
    }
  };

  if (!session) {
    return (
      <div className="text-center py-20 text-slate-500 animate-pulse font-black">
        Connecting to Table...
      </div>
    );
  }

  const isAdmin    = session.createdBy === user.id;
  const currentPlayer = players.find((player) => player.userId === user.id);
  const totalApproved = buyIns
    .filter((b) => b.status === 'approved')
    .reduce((sum, b) => sum + b.amount, 0);

  return (
    <div className="space-y-6 pb-12">
      <div className="text-center space-y-4">
        <h1 className="text-5xl font-black tracking-tighter text-white drop-shadow-2xl">
          {session.name}
        </h1>
        <div className="inline-flex items-center gap-3 px-6 py-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-[10px] font-black text-emerald-400 uppercase tracking-widest">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          Live Session • {session.blindValue} Blinds
        </div>
        <div>
          <button
            onClick={refreshData}
            className="inline-flex items-center gap-2 px-4 py-2 text-[10px] font-black text-slate-500 hover:text-white bg-slate-900 border border-slate-800 rounded-full transition-all"
          >
            <RefreshCw className="w-3 h-3" /> Refresh table
          </button>
        </div>
      </div>

      <section className="bg-sky-500/5 border border-sky-500/20 p-6 rounded-[2rem] flex items-start gap-4">
        <div className="w-11 h-11 rounded-xl bg-sky-500/10 text-sky-400 flex items-center justify-center shrink-0">
          <CalendarClock className="w-5 h-5" />
        </div>
        <div className="space-y-1">
          <p className="text-[10px] font-black uppercase tracking-widest text-sky-400">
            Your Play Plan
          </p>
          <p className="text-lg font-black text-white">
            {currentPlayer?.commitmentType === 'flexible'
              ? 'Keeping it flexible'
              : currentPlayer?.commitmentEndAt
                ? `Play until ${new Date(currentPlayer.commitmentEndAt).toLocaleTimeString(
                    [],
                    { hour: '2-digit', minute: '2-digit' }
                  )}`
                : 'Needs review'}
          </p>
          <p className="text-[10px] text-slate-500">
            This is for coordination, not pressure. You can leave whenever you need to.
          </p>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-slate-900 p-8 rounded-[2rem] border border-slate-800 shadow-2xl text-center hover:border-emerald-500/40 transition-all">
          <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
            Total Buy-In
          </p>
          <p className="text-4xl font-black text-emerald-400">₹{totalApproved}</p>
        </div>
        <div className="bg-slate-900 p-8 rounded-[2rem] border border-slate-800 shadow-2xl text-center flex flex-col items-center justify-center">
          <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
            Seat Role
          </p>
          <p className="text-xl font-black text-white uppercase tracking-tighter">
            {isAdmin ? 'Session Host' : 'Player'}
          </p>
        </div>
      </div>

      {isLeaving && !leavePending && (
        <form
          onSubmit={handleLeave}
          className="p-6 bg-rose-950/30 border-2 border-rose-500/30 rounded-3xl space-y-5"
        >
          <div className="space-y-1">
            <h3 className="text-lg font-black text-rose-400">Cash Out</h3>
            <p className="text-xs text-slate-400">Enter the chips you are leaving the table with.</p>
          </div>
          <div className="relative">
            <DollarSign className="absolute left-4 top-1/2 -translate-y-1/2 w-6 h-6 text-rose-400" />
            <input
              type="number"
              autoFocus
              min="0"
              className="w-full bg-slate-900 border border-slate-800 rounded-2xl pl-12 pr-4 py-5 focus:ring-2 focus:ring-rose-500 outline-none text-3xl font-black text-white"
              placeholder="0"
              value={outChips}
              onChange={(e) => setOutChips(e.target.value)}
            />
          </div>
          {currentPlayer?.commitmentType !== 'flexible' && (
            <label className="flex items-start gap-3 p-4 rounded-2xl bg-slate-900 border border-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={adjustPlan}
                onChange={(event) => setAdjustPlan(event.target.checked)}
                className="mt-0.5 accent-amber-500"
              />
              <span>
                <span className="block text-xs font-black text-slate-200">
                  My plan changed for a legitimate reason
                </span>
                <span className="block text-[10px] text-slate-500 mt-1">
                  The host will review this adjustment. No private explanation is required.
                </span>
              </span>
            </label>
          )}
          {leaveError && (
            <p className="text-rose-400 text-xs font-bold flex items-center gap-2">
              <AlertCircle className="w-4 h-4" /> {leaveError}
            </p>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => { setIsLeaving(false); setLeaveError(''); }}
              className="flex-1 py-4 bg-slate-800 hover:bg-slate-700 rounded-xl text-xs font-black text-slate-400 uppercase"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 py-4 bg-rose-500 text-white rounded-xl text-xs font-black uppercase shadow-xl shadow-rose-500/20 active:scale-95 transition-all"
            >
              Confirm Leave
            </button>
          </div>
        </form>
      )}

      {leavePending && (
        <section className="bg-amber-500/10 border border-amber-500/20 p-8 rounded-[2.5rem] text-center space-y-4">
          <div className="flex justify-center">
            <span className="flex items-center gap-2 text-[10px] font-black uppercase text-amber-500 bg-amber-500/10 px-5 py-2.5 rounded-full border border-amber-500/20 animate-pulse">
              <Clock className="w-4 h-4" /> Awaiting Admin Approval
            </span>
          </div>
          <h2 className="text-xl font-black text-amber-400">Leave Request Submitted</h2>
          <p className="text-xs text-slate-400">
            You requested to leave with <span className="text-white font-black">₹{pendingOutChips}</span> chips. Waiting for admin to approve.
          </p>
          <button
            onClick={handleCancelLeave}
            className="inline-flex items-center gap-2 px-8 py-3 bg-slate-800 hover:bg-slate-700 text-slate-400 text-xs font-black rounded-2xl transition-all active:scale-95"
          >
            Cancel Request
          </button>
        </section>
      )}

      {hasLeft && (
        <section className="bg-rose-500/10 border border-rose-500/20 p-8 rounded-[2.5rem] text-center space-y-4">
          <LogOut className="w-10 h-10 text-rose-400 mx-auto" />
          <h2 className="text-xl font-black text-rose-400">You Have Left This Table</h2>
          <p className="text-xs text-slate-400">
            Your chip count has been recorded. The admin will finalize your result when the session closes.
          </p>
          <div className="pt-1">
            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Total Chips In</p>
            <p className="text-3xl font-black text-white">₹{totalApproved}</p>
          </div>
          <button
            onClick={handleRejoin}
            className="inline-flex items-center gap-2 px-8 py-3 bg-slate-800 hover:bg-emerald-500 hover:text-slate-950 text-slate-300 text-xs font-black rounded-2xl transition-all active:scale-95"
          >
            <LogIn className="w-4 h-4" /> Rejoin Table
          </button>
        </section>
      )}

      {!hasLeft && !leavePending && (
      <section className="bg-slate-900 p-8 rounded-[2.5rem] border border-slate-800 shadow-2xl space-y-8">
        <div className="flex justify-between items-center">
          <h2 className="text-2xl font-black flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-500/10 rounded-xl flex items-center justify-center">
              <Plus className="w-5 h-5 text-emerald-500" />
            </div>
            Top Up
          </h2>
          {!isRequesting && !isLeaving && (
            <div className="flex items-center gap-2">
              {!isAdmin && (
                <button
                  onClick={() => setIsLeaving(true)}
                  className="px-4 py-3 bg-rose-500/10 hover:bg-rose-500 border border-rose-500/20 hover:border-rose-500 text-rose-400 hover:text-white text-xs font-black rounded-2xl transition-all active:scale-95 flex items-center gap-2"
                >
                  <LogOut className="w-4 h-4" /> Leave
                </button>
              )}
              <button
                onClick={() => setIsRequesting(true)}
                className="px-6 py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-black rounded-2xl transition-all shadow-xl shadow-emerald-500/30 active:scale-95 flex items-center gap-2"
              >
                Add Chips
              </button>
            </div>
          )}
        </div>

        {isRequesting && (
          <form
            onSubmit={handleRequest}
            className="p-6 bg-slate-950 border-2 border-emerald-500/30 rounded-3xl space-y-5"
          >
            <div className="space-y-3">
              <div className="flex justify-between items-center px-1">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                  Amount to Request
                </label>
                {isAdmin && (
                  <span className="text-[9px] font-black text-emerald-400 uppercase flex items-center gap-1.5">
                    <Zap className="w-3 h-3 fill-current" /> Instant Approval
                  </span>
                )}
              </div>
              <div className="relative">
                <DollarSign className="absolute left-4 top-1/2 -translate-y-1/2 w-6 h-6 text-emerald-500" />
                <input
                  type="number"
                  autoFocus
                  className="w-full bg-slate-900 border border-slate-800 rounded-2xl pl-12 pr-4 py-5 focus:ring-2 focus:ring-emerald-500 outline-none text-3xl font-black text-white"
                  placeholder="500"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setIsRequesting(false)}
                className="flex-1 py-4 bg-slate-800 hover:bg-slate-700 rounded-xl text-xs font-black text-slate-400 uppercase"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 py-4 bg-emerald-500 text-slate-950 rounded-xl text-xs font-black uppercase shadow-xl shadow-emerald-500/20 active:scale-95 transition-all"
              >
                {isAdmin ? 'Confirm Buy-In' : 'Request Chips'}
              </button>
            </div>
          </form>
        )}

        <div className="space-y-4">
          <div className="flex items-center gap-3 px-1">
            <History className="w-4 h-4 text-slate-600" />
            <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
              Transaction Statement
            </h3>
          </div>
          {buyIns.length === 0 ? (
            <div className="text-center py-20 bg-slate-950/50 rounded-3xl border border-slate-800/50">
              <p className="text-slate-600 font-bold italic text-sm">No chip history found</p>
            </div>
          ) : (
            <div className="space-y-3">
              {buyIns.map((b) => (
                <div
                  key={b.id}
                  className="flex items-center justify-between bg-slate-950 p-6 rounded-3xl border border-slate-800 hover:border-slate-700 transition-all"
                >
                  <div>
                    <p className="text-2xl font-black text-white">₹{b.amount}</p>
                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1">
                      {new Date(b.timestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>
                  <div>
                    {b.status === 'pending' && (
                      <span className="flex items-center gap-2 text-[10px] font-black uppercase text-amber-500 bg-amber-500/10 px-5 py-2.5 rounded-full border border-amber-500/20 animate-pulse">
                        <Clock className="w-4 h-4" /> Awaiting Admin
                      </span>
                    )}
                    {b.status === 'approved' && (
                      <span className="flex items-center gap-2 text-[10px] font-black uppercase text-emerald-400 bg-emerald-400/10 px-5 py-2.5 rounded-full border border-emerald-400/20">
                        <CheckCircle className="w-4 h-4" /> Processed
                      </span>
                    )}
                    {b.status === 'rejected' && (
                      <span className="flex items-center gap-2 text-[10px] font-black uppercase text-rose-400 bg-rose-400/10 px-5 py-2.5 rounded-full border border-rose-400/20">
                        <AlertCircle className="w-4 h-4" /> Rejected
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
      )}

      <section className="bg-slate-900 p-8 rounded-[2.5rem] border border-slate-800 shadow-2xl space-y-6">
        <div className="flex justify-between items-center">
          <h2 className="text-2xl font-black flex items-center gap-3">
            <div className="w-10 h-10 bg-sky-500/10 rounded-xl flex items-center justify-center">
              <Users className="w-5 h-5 text-sky-400" />
            </div>
            Table Buy-Ins
          </h2>
          <div className="text-right">
            <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Table Pot</p>
            <p className="text-xl font-black text-sky-400 tabular-nums">₹{tablePot.toLocaleString()}</p>
          </div>
        </div>

        {tableBuyIns.length === 0 ? (
          <div className="text-center py-12 bg-slate-950/50 rounded-3xl border border-slate-800/50">
            <p className="text-slate-600 font-bold italic text-sm">No approved buy-ins at the table yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {tableBuyIns.map((row, idx) => {
              const share = potShare(row.total, tablePot);
              return (
                <div
                  key={row.userId}
                  className={`relative bg-slate-950 p-4 rounded-2xl border ${row.isSelf ? 'border-emerald-500/40' : 'border-slate-800'} overflow-hidden`}
                >
                  <div
                    className={`absolute inset-y-0 left-0 ${row.isSelf ? 'bg-emerald-500/10' : 'bg-sky-500/5'}`}
                    style={{ width: `${share}%` }}
                  />
                  <div className="relative flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-black ${row.isSelf ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>
                        {idx + 1}
                      </div>
                      <div>
                        <p className="text-sm font-black text-white">
                          {row.name}
                          {row.isSelf && <span className="ml-2 text-[9px] font-black text-emerald-400 uppercase tracking-widest">You</span>}
                        </p>
                        <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">{share.toFixed(0)}% of pot</p>
                      </div>
                    </div>
                    <p className="text-lg font-black text-white tabular-nums">₹{row.total.toLocaleString()}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="text-center py-8 space-y-4 opacity-40">
        <ShieldCheck className="w-10 h-10 mx-auto text-slate-700" />
        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
          Audit-Ready Environment
        </p>
        <p className="text-[9px] text-slate-600 max-w-[200px] mx-auto leading-relaxed">
          All requests are timestamped and recorded in the table's global ledger.
        </p>
      </div>
    </div>
  );
}
