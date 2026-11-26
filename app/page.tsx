"use client";

import { useState, useEffect, useRef } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { Copy, Send, RefreshCw, Layers, MessageSquare, Check } from "lucide-react";

const urlsEnv = process.env.NEXT_PUBLIC_SUPABASE_URLS || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const keysEnv = process.env.NEXT_PUBLIC_SUPABASE_KEYS || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const provibeWebSocketUrl = process.env.NEXT_PUBLIC_PROVIBE_WS_URL || "wss://provibe.onrender.com";

const isValidWebSocketUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch {
    return false;
  }
};

const supabaseUrls: string[] = urlsEnv.split(',').map((u) => u.trim()).filter((u) => u.length > 0);
const supabaseKeys: string[] = keysEnv.split(',').map((k) => k.trim()).filter((k) => k.length > 0);

const supabaseClients: SupabaseClient[] = [];

supabaseUrls.forEach((url, index) => {
  const key = supabaseKeys[index];
  if (url && key) {
    try {
      supabaseClients.push(createClient(url, key));
    } catch (err) {
      console.error(`[WARN] db node init failed for ${url}:`, err);
    }
  }
});

/** Small thread rows: poll hard. Frames are large and polled slower. */
const THREAD_POLL_MS = 1500;
const FRAME_POLL_MS = 2500;

interface SessionData {
  id: string;
  batch_id: string;
  image_url: string | null;
  created_at: string;
}

interface ThreadRow {
  id: string;
  kind: string;
  sender: string;
  answer_text: string | null;
}

interface ChatLine {
  id: string;
  mine: boolean;
  text: string;
}

function CaptureImage({ src, id }: { src: string; id: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="rounded border border-red-900 bg-red-950/40 text-red-400 text-[11px] p-3 break-all">
        frame {id} failed to load — {src.slice(0, 56)}...
      </div>
    );
  }
  return (
    <img
      src={src}
      alt="Capture"
      onError={() => setFailed(true)}
      className="rounded border border-slate-700 w-full h-auto object-contain bg-black"
    />
  );
}

export default function FriendDashboard() {
  const [sessionCode, setSessionCode] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [closed, setClosed] = useState(false);
  const [batches, setBatches] = useState<Record<string, SessionData[]>>({});
  const [chatLines, setChatLines] = useState<ChatLine[]>([]);
  const [answer, setAnswer] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [status, setStatus] = useState("AWAITING CONNECTION...");
  const [serverStatus, setServerStatus] = useState("DISCONNECTED");
  const [serverMessage, setServerMessage] = useState("");

  const seenRef = useRef<Set<string>>(new Set());
  const chatEndRef = useRef<HTMLDivElement>(null);
  const serverSocketRef = useRef<WebSocket | null>(null);
  /** Highest frame created_at already pulled, so polls fetch new rows only. */
  const frameCursorRef = useRef<string>("");
  /** Node index that last accepted a write; sticks so a dead node is probed once. */
  const activeNodeRef = useRef(0);

  // Failover write — start where the last write worked, advance only on
  // failure, stay on whatever accepts. The `% total` wrap keeps every node
  // reachable, so a session that begins near the end can still fall back.
  const insertRow = async (payload: Record<string, unknown>): Promise<boolean> => {
    const total = supabaseClients.length;
    if (total === 0) return false;

    for (let step = 0; step < total; step++) {
      const idx = (activeNodeRef.current + step) % total;
      try {
        const { error } = await supabaseClients[idx].from("copilot_sessions").insert(payload);
        if (!error) {
          activeNodeRef.current = idx;
          return true;
        }
        console.warn("node rejected insert:", error.message);
      } catch (err) {
        console.warn("node threw on insert:", err);
      }
    }

    return false;
  };

  const fetchFrames = async (code: string) => {
    const cursor = frameCursorRef.current;
    const fresh: SessionData[] = [];

    await Promise.all(supabaseClients.map(async (client) => {
      try {
        let q = client
          .from("copilot_sessions")
          .select("id,batch_id,image_url,created_at")
          .eq("session_code", code)
          .eq("kind", "frame")
          .not("image_url", "is", null)
          .order("created_at", { ascending: true })
          .limit(50);
        if (cursor) q = q.gt("created_at", cursor);
        const { data, error } = await q;
        if (!error && data) fresh.push(...(data as SessionData[]));
      } catch { /* node down */ }
    }));

    if (!fresh.length) return;

    const seen = new Set<string>();
    const unique = fresh.filter((r) => !seen.has(r.id) && (seen.add(r.id), true));

    const newest = unique[unique.length - 1].created_at;
    if (newest > frameCursorRef.current) frameCursorRef.current = newest;

    setBatches((prev) => {
      const next = { ...prev };
      for (const row of unique) (next[row.batch_id] ||= []).push(row);
      return next;
    });
  };

  const fetchThread = async (code: string) => {
    const fresh: ThreadRow[] = [];
    await Promise.all(supabaseClients.map(async (client) => {
      try {
        const { data, error } = await client
          .from("copilot_sessions")
          .select("id,kind,sender,answer_text")
          .eq("session_code", code)
          .in("kind", ["chat", "answer"])
          .order("created_at", { ascending: true })
          .limit(200);
        if (!error && data) fresh.push(...(data as ThreadRow[]));
      } catch { /* node down */ }
    }));

    const unseen = fresh.filter((r) => r.id && !seenRef.current.has(r.id));
    if (!unseen.length) return;

    const newChat: ChatLine[] = [];
    let latestAnswer: string | null = null;

    for (const row of unseen) {
      seenRef.current.add(row.id);
      const text = row.answer_text ?? "";
      if (row.kind === "chat" && text.trim()) newChat.push({ id: row.id, mine: row.sender === "operator", text });
      else if (row.kind === "answer" && text.trim()) latestAnswer = text;
    }

    if (newChat.length) setChatLines((prev) => [...prev, ...newChat]);
    if (latestAnswer !== null) setAnswer(latestAnswer);
  };

  const checkClosed = async (code: string): Promise<boolean> => {
    let isClosed = false;
    await Promise.all(supabaseClients.map(async (client) => {
      try {
        const { data } = await client
          .from("copilot_control")
          .select("state")
          .eq("session_code", code)
          .maybeSingle();
        if (data?.state === "closed") isClosed = true;
      } catch { /* node down */ }
    }));
    return isClosed;
  };

  useEffect(() => {
    if (!isConnected || supabaseClients.length === 0 || closed) return;

    const code = sessionCode;
    fetchFrames(code);
    fetchThread(code);

    const threadTimer = setInterval(() => fetchThread(code), THREAD_POLL_MS);
    const frameTimer = setInterval(() => fetchFrames(code), FRAME_POLL_MS);
    const controlTimer = setInterval(async () => {
      if (await checkClosed(code)) {
        setClosed(true);
        setStatus("SESSION COMPLETE");
        setServerStatus("DISCONNECTED");
      }
    }, THREAD_POLL_MS);

    const channels = supabaseClients.map((client, index) =>
      client
        .channel(`copilot-session-${code}-${index}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "copilot_sessions", filter: `session_code=eq.${code}` },
          () => { fetchThread(code); fetchFrames(code); }
        )
        .subscribe()
    );

    setStatus("LIVE & SYNCED");

    return () => {
      clearInterval(threadTimer);
      clearInterval(frameTimer);
      clearInterval(controlTimer);
      channels.forEach((channel, index) => supabaseClients[index].removeChannel(channel));
    };
  }, [isConnected, closed, sessionCode]);

  useEffect(() => {
    if (!isConnected || closed) return;
    let disposed = false;
    let connectionFailed = false;
    const socket = new WebSocket(provibeWebSocketUrl);
    serverSocketRef.current = socket;
    socket.onopen = () => {
      try {
        socket.send(JSON.stringify({
          action: "set_session",
          session_code: sessionCode,
          client_type: "browser",
        }));
        if (!disposed) {
          setServerStatus("CONNECTED");
          setServerMessage("Connected to the ProVibe server.");
        }
      } catch (error) {
        connectionFailed = true;
        console.error("Could not join the ProVibe session:", error);
        if (!disposed) {
          setServerStatus("CONNECTION ERROR");
          setServerMessage("Connected to the server, but could not join this session.");
        }
      }
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      let message: { status?: unknown; data?: unknown; transcript?: unknown };
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        console.error("Received an invalid message from the ProVibe server:", error);
        if (!disposed) {
          setServerStatus("INVALID RESPONSE");
          setServerMessage("The ProVibe server returned an unreadable response.");
        }
        return;
      }

      if (!disposed && message.status === "error") {
        setServerStatus("SERVER ERROR");
        setServerMessage(typeof message.data === "string" ? message.data : "The ProVibe server rejected the request.");
      } else if (!disposed && typeof message.transcript === "string") {
        setServerMessage(message.transcript);
      }
    };
    socket.onerror = () => {
      connectionFailed = true;
      if (!disposed) {
        setServerStatus("CONNECTION ERROR");
        setServerMessage("Could not reach the ProVibe server. Check that the Render service is available.");
      }
    };
    socket.onclose = () => {
      if (serverSocketRef.current === socket) serverSocketRef.current = null;
      if (!disposed && !connectionFailed) {
        setServerStatus("DISCONNECTED");
        setServerMessage("The ProVibe server connection closed.");
      }
    };

    return () => {
      disposed = true;
      if (serverSocketRef.current === socket) serverSocketRef.current = null;
      socket.close();
    };
  }, [isConnected, closed, sessionCode]);

  useEffect(() => {
    if (chatEndRef.current) chatEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatLines]);

  const toggleConnection = () => {
    if (isConnected) {
      setIsConnected(false);
      setBatches({});
      setChatLines([]);
      setServerStatus("DISCONNECTED");
      setServerMessage("");
      seenRef.current = new Set();
      frameCursorRef.current = "";
      setStatus("DISCONNECTED");
    } else {
      if (!sessionCode.trim()) {
        setStatus("ENTER A CODE FIRST");
        return;
      }
      setStatus("CONNECTING...");
      if (!isValidWebSocketUrl(provibeWebSocketUrl)) {
        setServerStatus("CONNECTION ERROR");
        setServerMessage("The ProVibe WebSocket URL must use ws:// or wss://.");
        return;
      }
      setServerStatus("CONNECTING");
      setServerMessage("");
      setIsConnected(true);
    }
  };

  const newSession = () => {
    setClosed(false);
    setBatches({});
    setChatLines([]);
    setAnswer("");
    setChatDraft("");
    seenRef.current = new Set();
    frameCursorRef.current = "";
    activeNodeRef.current = 0;
    setSessionCode("");
    setIsConnected(false);
    setServerStatus("DISCONNECTED");
    setServerMessage("");
    setStatus("AWAITING CONNECTION...");
  };

  const copyBatchToClipboard = async (batchImages: SessionData[]) => {
    setStatus("STITCHING IMAGES...");
    try {
      const loaded = await Promise.all(
        batchImages.filter((b) => b.image_url).map(async (imgData) => {
          const response = await fetch(imgData.image_url as string);
          const blob = await response.blob();
          return new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(img.src); resolve(img); };
            img.onerror = reject;
            img.src = URL.createObjectURL(blob);
          });
        })
      );

      let totalHeight = 0;
      let maxWidth = 0;
      loaded.forEach((img) => {
        totalHeight += img.height;
        if (img.width > maxWidth) maxWidth = img.width;
      });

      const canvas = document.createElement("canvas");
      canvas.width = maxWidth;
      canvas.height = totalHeight;
      const ctx = canvas.getContext("2d");
      let y = 0;
      loaded.forEach((img) => { ctx?.drawImage(img, 0, y); y += img.height; });

      canvas.toBlob(async (blob) => {
        if (!blob) return;
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          setStatus("BATCH COPIED");
        } catch {
          setStatus("CLIPBOARD BLOCKED");
        }
        setTimeout(() => setStatus(closed ? "SESSION COMPLETE" : "LIVE & SYNCED"), 2500);
      }, "image/png");
    } catch {
      setStatus("FAILED TO COPY IMAGES");
    }
  };

  const sendChat = async () => {
    const text = chatDraft.trim();
    if (!text || !isConnected) return;
    setChatDraft("");
    const ok = await insertRow({
      session_code: sessionCode,
      batch_id: `chat_${Date.now()}`,
      kind: "chat",
      sender: "operator",
      answer_text: text,
    });
    if (!ok) setStatus("CHAT FAILED — ALL NODES");
    else {
      const socket = serverSocketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ action: "text_query", session_code: sessionCode, text }));
          setStatus("CHAT SENT");
        } catch (error) {
          console.error("Could not send chat to the ProVibe server:", error);
          setStatus("CHAT SAVED; SERVER SEND FAILED");
        }
      } else {
        setStatus("CHAT SAVED; SERVER OFFLINE");
      }
    }
  };

  const sendAnswer = async () => {
    if (!answer.trim() || !isConnected) return;
    setStatus("SENDING...");
    const ok = await insertRow({
      session_code: sessionCode,
      batch_id: "reply_" + Date.now(),
      kind: "answer",
      sender: "operator",
      answer_text: answer,
    });
    setStatus(ok ? "ANSWER DELIVERED" : "FAILED TO SEND (ALL NODES)");
    setTimeout(() => setStatus(closed ? "SESSION COMPLETE" : "LIVE & SYNCED"), 2500);
  };

  if (closed) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-300 font-mono flex flex-col items-center justify-center gap-6">
        <Check className="w-12 h-12 text-emerald-500" />
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold text-white tracking-widest">SESSION COMPLETE</h1>
          <p className="text-sm text-slate-500">Session {sessionCode} has been closed by the copilot.</p>
          <p className="text-sm text-slate-500">Ask for the new code to continue.</p>
        </div>
        <button onClick={newSession} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-6 py-2 rounded">
          ENTER NEW CODE
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-300 font-mono p-6">
      <div className="max-w-7xl mx-auto space-y-6">

        <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Layers className="text-emerald-500" />
            <h1 className="text-xl font-bold text-white tracking-widest">OVERSEER TERMINAL</h1>
          </div>

          <div className="flex items-center gap-3">
            <span className={`text-xs font-bold px-3 py-1 rounded ${
              isConnected ? "bg-emerald-900 text-emerald-400" : "bg-red-900 text-red-400"
            }`}>
              {status}
            </span>
            <span
              title={serverMessage}
              className={`text-xs font-bold px-3 py-1 rounded ${
                serverStatus === "CONNECTED" ? "bg-emerald-900 text-emerald-400" : "bg-amber-900 text-amber-400"
              }`}
            >
              SERVER {serverStatus}
            </span>
            <input
              type="text"
              placeholder="ENTER 6-DIGIT CODE"
              value={sessionCode}
              onChange={(e) => setSessionCode(e.target.value.toUpperCase())}
              disabled={isConnected}
              className="bg-slate-950 border border-slate-700 rounded px-3 py-1 text-sm outline-none focus:border-emerald-500"
            />
            <button onClick={toggleConnection} className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold px-4 py-1 rounded transition-colors">
              {isConnected ? "DISCONNECT" : "CONNECT"}
            </button>
          </div>
        </div>

        {serverMessage && (
          <p role="status" className={`text-xs ${serverStatus === "CONNECTED" ? "text-slate-500" : "text-amber-400"}`}>
            {serverMessage}
          </p>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">

          {/* FEED */}
          <div className="lg:col-span-2 space-y-6 overflow-y-auto max-h-[80vh] pr-2">
            {!isConnected && (
              <div className="flex flex-col items-center justify-center h-64 border-2 border-dashed border-slate-800 rounded-xl text-slate-500">
                <RefreshCw className="w-8 h-8 mb-3 animate-spin opacity-50" />
                <p>Waiting for connection...</p>
              </div>
            )}

            {isConnected && Object.keys(batches).length === 0 && (
              <div className="flex flex-col items-center justify-center h-64 border-2 border-dashed border-amber-900 rounded-xl text-amber-600">
                <RefreshCw className="w-8 h-8 mb-3 animate-spin opacity-50" />
                <p>Connected to {sessionCode} — no frames yet.</p>
                <p className="text-xs mt-2 text-slate-500">Ask the copilot to capture and send.</p>
              </div>
            )}

            {Object.keys(batches).reverse().map((batchId) => (
              <div key={batchId} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                <div className="bg-slate-800/50 p-3 flex items-center justify-between border-b border-slate-800">
                  <span className="text-xs font-bold text-slate-400">BATCH: {batchId}</span>
                  <button onClick={() => copyBatchToClipboard(batches[batchId])} className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold px-3 py-1.5 rounded">
                    <Copy className="w-4 h-4" /> COPY ALL IMAGES
                  </button>
                </div>
                <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-950">
                  {batches[batchId].map((img) => (
                    <CaptureImage key={img.id} src={img.image_url as string} id={img.id} />
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* CHAT */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col h-[80vh]">
            <h2 className="text-sm font-bold text-sky-400 mb-4 border-b border-slate-800 pb-2 flex items-center gap-2">
              <MessageSquare className="w-4 h-4" /> CHAT
            </h2>
            <div className="flex-1 overflow-y-auto space-y-2 text-sm pr-1">
              {chatLines.length === 0 && <p className="text-slate-600 text-xs italic">No chat yet.</p>}
              {chatLines.map((line) => (
                <div key={line.id} className={line.mine ? "text-right" : ""}>
                  <span className={`inline-block px-2 py-1 rounded ${line.mine ? "bg-sky-900/60 text-sky-100" : "bg-slate-800 text-slate-200"}`}>
                    {line.text}
                  </span>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <div className="flex gap-2 mt-3">
              <input
                value={chatDraft}
                onChange={(e) => setChatDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") sendChat(); }}
                placeholder="Type a chat message..."
                className="flex-1 bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm outline-none focus:border-sky-500"
              />
              <button onClick={sendChat} disabled={!chatDraft.trim() || !isConnected} className="bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white px-3 rounded">
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* ANSWER */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col h-[80vh]">
            <h2 className="text-sm font-bold text-emerald-500 mb-4 border-b border-slate-800 pb-2">ANSWER</h2>
            <textarea
              className="flex-1 bg-slate-950 border border-slate-700 rounded-lg p-3 text-sm text-white resize-none outline-none focus:border-emerald-500 font-mono"
              placeholder="Paste the answer here. It appears on their screen instantly."
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
            <button
              onClick={sendAnswer}
              disabled={!isConnected || !answer.trim()}
              className="mt-4 flex items-center justify-center gap-2 w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold py-3 rounded-lg"
            >
              <Send className="w-4 h-4" /> TRANSMIT
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}