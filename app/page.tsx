"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "wss://provibe.onrender.com";
const supabaseUrls = (process.env.NEXT_PUBLIC_SUPABASE_URL || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const supabaseKeys = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const supabaseClients: SupabaseClient[] = supabaseUrls.flatMap((url, index) => {
  const key = supabaseKeys[index];
  if (!key) return [];
  try {
    return [createClient(url, key)];
  } catch (error) {
    console.error(`Supabase client ${index + 1} could not be initialized.`, error);
    return [];
  }
});

interface SharedFrame {
  id: string;
  image_url: string;
}

interface ChatMessage {
  id: string;
  sender: "desktop" | "browser";
  text: string;
}

interface ServerMessage {
  status?: string;
  data?: string;
  sharing?: boolean;
  history?: Array<Record<string, unknown>>;
  frame?: SharedFrame;
  message?: ChatMessage;
}

export default function FriendDashboard() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [sessionCode, setSessionCode] = useState("");
  const [connected, setConnected] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [frames, setFrames] = useState<SharedFrame[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatText, setChatText] = useState("");
  const [status, setStatus] = useState("Sign in to join a sharing session.");
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => () => socketRef.current?.close(), []);

  const authenticate = async (mode: "sign-in" | "sign-up") => {
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      setStatus("Enter your email and password.");
      return;
    }
    if (supabaseClients.length === 0) {
      setStatus("Supabase is not configured. Set the NEXT_PUBLIC_SUPABASE_URL and anon-key variables.");
      return;
    }

    setStatus(mode === "sign-in" ? "Signing in..." : "Creating account...");
    let lastError = "No configured Supabase project accepted this sign-in.";
    for (const client of supabaseClients) {
      try {
        const result = mode === "sign-in"
          ? await client.auth.signInWithPassword({ email: normalizedEmail, password })
          : await client.auth.signUp({ email: normalizedEmail, password });
        if (result.error) {
          lastError = result.error.message;
          continue;
        }
        if (!result.data.session) {
          setStatus("Account created. Confirm your email, then sign in.");
          return;
        }
        setAccessToken(result.data.session.access_token);
        setStatus(`Signed in as ${result.data.user?.email ?? normalizedEmail}.`);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Supabase sign-in failed.";
      }
    }
    setStatus(lastError);
  };

  const connect = () => {
    if (!accessToken) {
      setStatus("Sign in before joining a session.");
      return;
    }
    const code = sessionCode.trim().toUpperCase();
    if (!/^[A-F0-9]{16}$/.test(code)) {
      setStatus("Enter the 16-character session code from the desktop host.");
      return;
    }
    setSessionCode(code);

    let socket: WebSocket;
    try {
      socket = new WebSocket(WS_URL);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not open the backend connection.");
      return;
    }
    socketRef.current = socket;
    setStatus("Connecting to the Render server...");
    socket.onopen = () => {
      socket.send(JSON.stringify({
        action: "set_session",
        session_code: code,
        client_type: "browser",
        access_token: accessToken,
      }));
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data);
      } catch {
        setStatus("The backend sent an invalid response.");
        return;
      }
      if (message.status === "session_ready") {
        setConnected(true);
        setSharing(Boolean(message.sharing));
        setStatus("Connected. Screen sharing starts only when the desktop host chooses Start Sharing.");
        const history = message.history ?? [];
        setFrames(history
          .filter((row) => row.kind === "frame" && typeof row.image_url === "string")
          .map((row) => ({ id: String(row.id), image_url: String(row.image_url) })));
        setMessages(history
          .filter((row) => row.kind === "chat" && typeof row.answer_text === "string")
          .map((row) => ({
            id: String(row.id),
            sender: row.sender === "desktop" ? "desktop" : "browser",
            text: String(row.answer_text),
          })));
      } else if (message.status === "sharing_started") {
        setSharing(true);
      } else if (message.status === "sharing_stopped") {
        setSharing(false);
      } else if (message.status === "frame" && message.frame) {
        setFrames((current) => [...current, message.frame!].slice(-30));
      } else if (message.status === "chat_message" && message.message) {
        setMessages((current) => [...current, message.message!].slice(-100));
      } else if (message.status === "session_ended") {
        setConnected(false);
        setSharing(false);
        setStatus("The desktop host ended this session.");
        socket.close();
      } else if (message.status === "error") {
        setStatus(message.data ?? "The server rejected the request.");
      }
    };
    socket.onerror = () => setStatus("Could not reach the Render WebSocket server.");
    socket.onclose = () => {
      socketRef.current = null;
      setConnected(false);
      setSharing(false);
    };
  };

  const disconnect = () => {
    socketRef.current?.close();
    socketRef.current = null;
    setConnected(false);
    setSharing(false);
    setStatus("Disconnected.");
  };

  const sendChat = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      setStatus("Not connected to a sharing session.");
      return;
    }
    socket.send(JSON.stringify({ action: "chat", session_code: sessionCode, text }));
    setChatText("");
  };

  return (
    <main className="min-h-screen bg-slate-950 p-6 font-sans text-slate-200">
      <div className="mx-auto grid max-w-6xl gap-5">
        <header className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900 p-5">
          <div>
            <h1 className="text-xl font-bold text-white">ProBuddy — Screen Sharing</h1>
            <p className="mt-1 text-sm text-slate-400">Join an explicit-consent desktop sharing session.</p>
          </div>
          <span role="status" className={`rounded px-3 py-1 text-xs font-bold ${sharing ? "bg-emerald-900 text-emerald-300" : "bg-slate-800 text-slate-300"}`}>
            {sharing ? "SHARING ACTIVE" : connected ? "CONNECTED — NOT SHARING" : "DISCONNECTED"}
          </span>
        </header>

        {!accessToken ? (
          <section className="grid max-w-md gap-3 rounded-xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="font-semibold text-white">Supabase sign-in</h2>
            <label className="grid gap-1 text-sm">Email
              <input autoComplete="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="rounded border border-slate-700 bg-slate-950 px-3 py-2" />
            </label>
            <label className="grid gap-1 text-sm">Password
              <input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="rounded border border-slate-700 bg-slate-950 px-3 py-2" />
            </label>
            <div className="flex gap-2">
              <button onClick={() => void authenticate("sign-in")} className="rounded bg-sky-700 px-4 py-2 font-semibold text-white">Sign in</button>
              <button onClick={() => void authenticate("sign-up")} className="rounded bg-slate-700 px-4 py-2 font-semibold text-white">Create account</button>
            </div>
          </section>
        ) : (
          <section className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-800 bg-slate-900 p-5">
            <label className="grid gap-1 text-sm">Session code
              <input value={sessionCode} onChange={(event) => setSessionCode(event.target.value.toUpperCase())} disabled={connected} placeholder="16-character code" maxLength={16} className="rounded border border-slate-700 bg-slate-950 px-3 py-2 font-mono uppercase" />
            </label>
            {connected
              ? <button onClick={disconnect} className="rounded bg-slate-700 px-4 py-2 font-semibold">Disconnect</button>
              : <button onClick={connect} className="rounded bg-sky-700 px-4 py-2 font-semibold text-white">Join session</button>}
            <p className="basis-full text-sm text-slate-400">{status}</p>
          </section>
        )}

        {accessToken && <p role="status" className="text-sm text-slate-400">{status}</p>}

        <section className="grid gap-5 lg:grid-cols-[2fr_1fr]">
          <div className="grid content-start gap-3 rounded-xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="font-semibold text-white">Shared screen</h2>
            {!sharing && <p className="text-sm text-slate-400">Waiting for the desktop host to start sharing.</p>}
            {frames.length > 0 && (
              <img src={frames[frames.length - 1].image_url} alt="Most recent shared screen" className="max-h-[70vh] w-full rounded border border-slate-700 bg-black object-contain" />
            )}
          </div>

          <section className="flex min-h-96 flex-col rounded-xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="mb-3 font-semibold text-white">Session chat</h2>
            <div aria-live="polite" className="flex-1 space-y-2 overflow-auto text-sm">
              {messages.map((message) => (
                <p key={message.id}><strong>{message.sender === "desktop" ? "Desktop" : "You"}:</strong> {message.text}</p>
              ))}
            </div>
            <form onSubmit={sendChat} className="mt-4 flex gap-2">
              <input value={chatText} onChange={(event) => setChatText(event.target.value)} disabled={!connected} maxLength={4000} placeholder="Send a message" className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-3 py-2" />
              <button disabled={!connected || !chatText.trim()} className="rounded bg-sky-700 px-3 font-semibold text-white disabled:opacity-50">Send</button>
            </form>
          </section>
        </section>
      </div>
    </main>
  );
}
