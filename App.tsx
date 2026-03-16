import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Volume2, 
  Mic, 
  Play, 
  X, 
  AlertTriangle, 
  Info, 
  Eye, 
  Power,
  Activity,
  Map as MapIcon
} from 'lucide-react';
import { SessionStatus, type Alert, type SceneSummary } from './types';
import { encode, decode, decodeAudioData } from './services/audioService';
import {
  createSession, endSession, logAlert, logTextRead,
  getSessions, getAnalytics, deleteSession,
  type Session, type Analytics,
} from './services/sessionService';

// ─── Constants ────────────────────────────────────────────────────────────────

const MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const IMAGE_MODEL = 'gemini-2.0-flash-preview-image-generation';
const FRAME_RATE = 4; // 4fps
const JPEG_QUALITY = 0.5;
const ALERT_THROTTLE = 8000;

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a real-time AI vision assistant for visually impaired and blind users.
You receive a continuous live video feed from the user's camera.

YOUR CORE JOB:
1. EXPLORE & DESCRIBE: Continuously scan the environment. Call update_scene_summary() every 10-15 seconds with a fresh scene description.
2. READ TEXT: Focus on any text (signs, labels, menus, screens, documents). Read it aloud immediately AND call proactive_alert() with type "text".
3. NAVIGATE & SAFETY: Focus on path safety. Immediately alert about: steps/stairs, curbs, drop-offs, narrow passages, wet floors, obstacles, approaching people/vehicles.

PROACTIVE ALERTS — call proactive_alert() without waiting to be asked when you see:
- Any obstacle within 2-3 steps
- Stairs or steps (specify up or down)
- Doors (open or closed, which direction they open)
- People (how many, roughly where)
- Vehicles or traffic
- Hazardous surfaces (wet, uneven, slippery)
- Important signage or text

WHEN SPOKEN TO — answer immediately and naturally:
- "What's in front of me?" / "Describe the scene" → detailed verbal description + update_scene_summary()
- "Read this" / "What does it say?" → read visible text clearly + proactive_alert(type="text")
- "What is this?" / "What am I holding?" → identify object + proactive_alert(type="object")
- "Is it safe?" / "Can I walk forward?" → assess path safety
- "How many steps?" → count visible steps precisely
- "What color is...?" → describe colors accurately
- "Where is the...?" → directional guidance using clock positions

COMMUNICATION STYLE:
- Be BRIEF and CLEAR — essential for safety
- Use clock positions: "obstacle at 10 o'clock"
- Speak distances in steps or feet
- Urgent hazards FIRST
- Be calm and reassuring
- Pause for user response

CRITICAL: Safety always first. When in doubt, warn.`;

// ─── Tools ────────────────────────────────────────────────────────────────────

const TOOLS: FunctionDeclaration[] = [
  {
    name: 'proactive_alert',
    parameters: {
      type: Type.OBJECT,
      description: 'Warn the user about something important in the environment. Call this proactively without being asked.',
      properties: {
        message: {
          type: Type.STRING,
          description: "Clear, concise alert message. Use clock positions for direction. E.g. \"Step down at 12 o'clock, 2 feet ahead.\"",
        },
        urgent: {
          type: Type.BOOLEAN,
          description: 'True for immediate hazards (stairs, obstacles, vehicles). False for informational alerts.',
        },
        type: {
          type: Type.STRING,
          description: 'Category: hazard (obstacle/stairs/danger), info (general scene info), text (readable text), object (identified object)',
        },
      },
      required: ['message', 'urgent', 'type'],
    },
  },
  {
    name: 'update_scene_summary',
    parameters: {
      type: Type.OBJECT,
      description: 'Update the scene summary panel with a structured description of the current environment.',
      properties: {
        description: {
          type: Type.STRING,
          description: 'Overall scene description in 1-2 sentences.',
        },
        hazards: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'List of current hazards or obstacles. Empty array if none.',
        },
        textVisible: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'List of readable text items visible in the scene.',
        },
      },
      required: ['description', 'hazards', 'textVisible'],
    },
  },
  {
    name: 'generate_tactile_map',
    parameters: {
      type: Type.OBJECT,
      description: 'Generate a simplified overhead diagram of the current space for visual reference.',
      properties: {
        prompt: {
          type: Type.STRING,
          description: 'Description of the space to diagram. The image will be a simple black-on-white overhead map.',
        },
      },
      required: ['prompt'],
    },
  },
];

// ─── Utility helpers ──────────────────────────────────────────────────────────

function timeAgo(date: Date): string {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

// ─── History Panel ────────────────────────────────────────────────────────────

const HistoryPanel = ({ onClose }: { onClose: () => void }) => {
  const [sessions, setSessions] = React.useState<Session[]>([]);
  const [analytics, setAnalytics] = React.useState<Analytics | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [tab, setTab] = React.useState<'sessions' | 'analytics'>('sessions');

  React.useEffect(() => {
    setLoading(true);
    Promise.all([getSessions(), getAnalytics()]).then(([s, a]) => {
      setSessions(s);
      setAnalytics(a);
      setLoading(false);
    });
  }, []);

  const handleDelete = async (id: string) => {
    await deleteSession(id);
    setSessions(prev => prev.filter(s => s.id !== id));
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  };

  const formatDuration = (start: string | null, end: string | null) => {
    if (!start || !end) return '—';
    const ms = new Date(end).getTime() - new Date(start).getTime();
    const mins = Math.round(ms / 60000);
    return mins < 1 ? '<1 min' : `${mins} min`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="bg-[#111] rounded-2xl shadow-2xl w-[680px] max-h-[80vh] flex flex-col border-2 border-yellow-500/30">
        <div className="flex items-center justify-between px-8 py-5 border-b border-yellow-500/20">
          <div>
            <h2 className="text-lg font-black text-yellow-400 uppercase tracking-widest">Session History</h2>
            <p className="text-xs text-gray-500 mt-0.5">Stored in Firestore · Cloud Run Backend</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-2xl font-light leading-none transition-colors" aria-label="Close">
            <X className="w-6 h-6" strokeWidth={2.5} />
          </button>
        </div>

        <div className="flex gap-1 px-8 pt-4">
          {(['sessions', 'analytics'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-[11px] font-black uppercase tracking-widest px-4 py-1.5 rounded-full transition-all ${
                tab === t ? 'bg-yellow-400 text-black' : 'text-gray-500 hover:bg-gray-800 hover:text-gray-300'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-4">
          {loading ? (
            <div className="text-center py-16 text-gray-500 text-sm">Loading from Firestore...</div>
          ) : tab === 'sessions' ? (
            sessions.length === 0 ? (
              <div className="text-center py-16 text-gray-500 text-sm">No sessions yet. Start a session to begin tracking.</div>
            ) : (
              <div className="space-y-3">
                {sessions.map(s => (
                  <div key={s.id} className="border border-gray-800 rounded-xl p-4 hover:border-yellow-500/30 transition-all bg-[#0d0d0d]">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${s.status === 'active' ? 'bg-yellow-400 animate-pulse' : 'bg-gray-600'}`}></div>
                        <span className="text-[10px] font-black uppercase px-2.5 py-1 rounded-full bg-yellow-900 text-yellow-300">{s.mode}</span>
                        <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${s.status === 'active' ? 'bg-yellow-900 text-yellow-400' : 'bg-gray-800 text-gray-500'}`}>{s.status}</span>
                      </div>
                      <button onClick={() => handleDelete(s.id)} className="text-[10px] text-red-500 hover:text-red-400 font-black uppercase transition-colors">Delete</button>
                    </div>
                    <div className="grid grid-cols-3 gap-3 text-center">
                      {[['Alerts', s.alertsCount ?? 0], ['Texts Read', s.textReadCount ?? 0], ['Duration', formatDuration(s.startedAt, s.endedAt)]].map(([label, val]) => (
                        <div key={label as string} className="bg-[#1a1a1a] rounded-lg p-2.5">
                          <div className="text-sm font-black text-white">{val}</div>
                          <div className="text-[10px] text-gray-500">{label}</div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2.5 text-[10px] text-gray-600">{formatDate(s.startedAt)} · ID: {s.id.slice(0, 8)}…</div>
                  </div>
                ))}
              </div>
            )
          ) : analytics ? (
            <div className="space-y-6 py-2">
              <div className="grid grid-cols-2 gap-4">
                {[
                  { label: 'Total Sessions', value: analytics.totalSessions },
                  { label: 'Completed Sessions', value: analytics.completedSessions },
                  { label: 'Total Alerts Issued', value: analytics.totalAlerts },
                  { label: 'Text Reads', value: analytics.totalTextReads },
                ].map(({ label, value }) => (
                  <div key={label} className="border border-gray-800 rounded-xl p-5 text-center bg-[#0d0d0d]">
                    <div className="text-3xl font-black mb-1 text-yellow-400">{value}</div>
                    <div className="text-xs text-gray-500">{label}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center py-16 text-gray-500 text-sm">Failed to load analytics. Is the backend running?</div>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Main App ─────────────────────────────────────────────────────────────────

const App: React.FC = () => {
  // ── State ──────────────────────────────────────────────────────────────────
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.DISCONNECTED);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [sceneSummary, setSceneSummary] = useState<SceneSummary | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [inputVolume, setInputVolume] = useState(0);
  const [showCamera, setShowCamera] = useState(true);
  const [mapImageUrl, setMapImageUrl] = useState<string | null>(null);
  const [toastAlert, setToastAlert] = useState<Alert | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  // ── Backend state ──────────────────────────────────────────────────────────
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const sessionRef = useRef<any>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastAlertTime = useRef<number>(0);
  const frameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firestoreSessionId = useRef<string | null>(null);

  // ── Backend health check ──────────────────────────────────────────────────
  useEffect(() => {
    const backendUrl = (import.meta as any).env?.VITE_BACKEND_URL || 'http://localhost:8080';
    fetch(`${backendUrl}/health`)
      .then(r => r.ok ? setBackendOk(true) : setBackendOk(false))
      .catch(() => setBackendOk(false));
  }, []);

  // ── Toast management ──────────────────────────────────────────────────────
  const showToast = useCallback((alert: Alert) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastAlert(alert);
    setToastVisible(true);
    toastTimerRef.current = setTimeout(() => setToastVisible(false), 5000);
  }, []);

  // ── Generate tactile map ──────────────────────────────────────────────────
  const generateTactileMap = useCallback(async (prompt: string) => {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: IMAGE_MODEL,
        contents: {
          parts: [{
            text: `Create a simplified overhead diagram/map of: ${prompt}. Style: black lines on pure white background, minimal, high contrast, like a tactile map. Simple geometric shapes representing walls, furniture, obstacles. Include a north arrow or direction indicator. No colors, no gradients, no shading — just clean black outlines on white.`,
          }],
        },
      });
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          setMapImageUrl(`data:image/png;base64,${part.inlineData.data}`);
          break;
        }
      }
    } catch (err) {
      console.error('[generateTactileMap] error:', err);
    }
  }, []);

  // ── Stop session ──────────────────────────────────────────────────────────
  const stopSession = useCallback(async () => {
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    if (firestoreSessionId.current) {
      await endSession(firestoreSessionId.current);
      firestoreSessionId.current = null;
    }
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (_) {}
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (sourcesRef.current) {
      sourcesRef.current.forEach(s => { try { s.stop(); } catch (_) {} });
      sourcesRef.current.clear();
    }
    if (inputAudioCtxRef.current) {
      try { await inputAudioCtxRef.current.close(); } catch (_) {}
      inputAudioCtxRef.current = null;
    }
    if (outputAudioCtxRef.current) {
      try { await outputAudioCtxRef.current.close(); } catch (_) {}
      outputAudioCtxRef.current = null;
    }
    nextStartTimeRef.current = 0;
    setStatus(SessionStatus.DISCONNECTED);
    setIsSpeaking(false);
    setInputVolume(0);
    setSceneSummary(null);
    setMapImageUrl(null);
    setToastVisible(false);
  }, []);

  // ── Start session ─────────────────────────────────────────────────────────
  const startSession = useCallback(async () => {
    try {
      setStatus(SessionStatus.CONNECTING);
      setAlerts([]);
      setSceneSummary(null);
      setMapImageUrl(null);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      inputAudioCtxRef.current = new AudioContext({ sampleRate: 16000 });
      outputAudioCtxRef.current = new AudioContext({ sampleRate: 24000 });

      // Request camera (rear-facing preferred) + mic
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 320 },
          height: { ideal: 240 },
        },
      });

      if (videoRef.current) {
        videoRef.current.srcObject = streamRef.current;
      }

      // Create Firestore session
      firestoreSessionId.current = await createSession('default');

      const sessionPromise = ai.live.connect({
        model: MODEL,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseModalities: [Modality.AUDIO],
          tools: [{ functionDeclarations: TOOLS }],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } },
        },
        callbacks: {
          onopen: () => {
            setStatus(SessionStatus.CONNECTED);

            // ── Microphone audio processing ──
            const source = inputAudioCtxRef.current!.createMediaStreamSource(streamRef.current!);
            const processor = inputAudioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (e) => {
              const data = e.inputBuffer.getChannelData(0);
              // Calculate RMS volume for visualizer
              let sum = 0;
              for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
              setInputVolume(Math.sqrt(sum / data.length) * 200);

              // Encode and send PCM audio
              const int16 = new Int16Array(data.length);
              for (let i = 0; i < data.length; i++) int16[i] = Math.max(-32768, Math.min(32767, data[i] * 32768));
              sessionPromise.then(s => {
                if (s) s.sendRealtimeInput({ media: { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' } });
              });
            };
            source.connect(processor);
            processor.connect(inputAudioCtxRef.current!.destination);

            // ── Video frame capture at FRAME_RATE ──
            frameIntervalRef.current = setInterval(() => {
              if (!videoRef.current || !canvasRef.current) return;
              const ctx = canvasRef.current.getContext('2d');
              if (!ctx) return;
              canvasRef.current.width = 240;
              canvasRef.current.height = 180;
              ctx.drawImage(videoRef.current, 0, 0, 240, 180);

              canvasRef.current.toBlob(blob => {
                if (!blob) return;
                const reader = new FileReader();
                reader.onloadend = () => {
                  sessionPromise.then(s => {
                    if (s) {
                      s.sendRealtimeInput({
                        media: {
                          data: (reader.result as string).split(',')[1],
                          mimeType: 'image/jpeg',
                        },
                      });
                    }
                  });
                };
                reader.readAsDataURL(blob);
              }, 'image/jpeg', JPEG_QUALITY);
            }, 1000 / FRAME_RATE);
          },

          onmessage: async (msg: LiveServerMessage) => {
            // ── Tool calls ──
            if (msg.toolCall) {
              for (const fc of msg.toolCall.functionCalls) {
                const args = fc.args as any;

                if (fc.name === 'proactive_alert') {
                  const now = Date.now();
                  if (now - lastAlertTime.current >= ALERT_THROTTLE || args.urgent) {
                    lastAlertTime.current = now;
                    const newAlert: Alert = {
                      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                      type: args.type || 'info',
                      message: args.message,
                      timestamp: new Date(),
                      urgent: !!args.urgent,
                    };
                    setAlerts(prev => [newAlert, ...prev].slice(0, 10));
                    if (args.urgent) showToast(newAlert);
                    // Log to Firestore
                    if (firestoreSessionId.current) {
                      logAlert(firestoreSessionId.current);
                      if (args.type === 'text') logTextRead(firestoreSessionId.current);
                    }
                  }
                } else if (fc.name === 'update_scene_summary') {
                  setSceneSummary({
                    description: args.description || '',
                    hazards: args.hazards || [],
                    textVisible: args.textVisible || [],
                    updatedAt: new Date(),
                  });
                } else if (fc.name === 'generate_tactile_map') {
                  generateTactileMap(args.prompt);
                }

                // Send tool response
                sessionPromise.then(s => {
                  if (s) {
                    s.sendToolResponse({
                      functionResponses: { id: fc.id, name: fc.name, response: { result: 'OK' } },
                    });
                  }
                });
              }
            }

            // ── Audio output ──
            const audio = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio && outputAudioCtxRef.current) {
              const ctx = outputAudioCtxRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(audio), ctx, 24000, 1);
              const bufferSource = ctx.createBufferSource();
              bufferSource.buffer = buffer;
              bufferSource.connect(ctx.destination);
              bufferSource.addEventListener('ended', () => {
                sourcesRef.current.delete(bufferSource);
                if (sourcesRef.current.size === 0) setIsSpeaking(false);
              });
              bufferSource.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(bufferSource);
              setIsSpeaking(true);
            }

            // ── Interrupted (user spoke) ──
            if (msg.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch (_) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsSpeaking(false);
            }
          },

          onclose: () => stopSession(),
          onerror: (e: any) => {
            console.error('[Live API] error:', e);
            setStatus(SessionStatus.ERROR);
            setTimeout(() => stopSession(), 2000);
          },
        },
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error('[startSession] error:', err);
      setStatus(SessionStatus.ERROR);
      setTimeout(() => stopSession(), 2000);
    }
  }, [stopSession, showToast, generateTactileMap]);

  // ── Toggle connect ────────────────────────────────────────────────────────
  const handleToggleConnect = useCallback(() => {
    if (status === SessionStatus.DISCONNECTED || status === SessionStatus.ERROR) {
      startSession();
    } else if (status === SessionStatus.CONNECTED) {
      stopSession();
    }
  }, [status, startSession, stopSession]);

  // ── Render ────────────────────────────────────────────────────────────────

  const isConnected = status === SessionStatus.CONNECTED;
  const isConnecting = status === SessionStatus.CONNECTING;

  return (
    <div className="flex flex-col h-screen w-screen bg-[#0a0a0a] overflow-hidden text-white">
      {/* ══ Header ══════════════════════════════════════════════════════════ */}
      <header className="h-16 flex items-center justify-between px-4 sm:px-6 border-b border-white/5 bg-black/80 backdrop-blur-md shrink-0 z-30">
        {/* Left: Branding */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Eye className="w-8 h-8 text-yellow-400" strokeWidth={3} />
            <span className="text-xl font-black text-yellow-400 tracking-tight">EyeFriend</span>
          </div>
        </div>

        {/* Center: Backend status + History */}
        <div className="hidden sm:flex items-center gap-2">
          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest border-2 ${
            backendOk === true ? 'bg-yellow-900/30 text-yellow-400 border-yellow-800' :
            backendOk === false ? 'bg-red-900/30 text-red-400 border-red-900' :
            'bg-gray-800 text-gray-500 border-gray-700'
          }`}>
            <div className={`w-1.5 h-1.5 rounded-full ${backendOk === true ? 'bg-yellow-400' : backendOk === false ? 'bg-red-500' : 'bg-gray-500'}`}></div>
            {backendOk === true ? 'Cloud Run' : backendOk === false ? 'Offline' : 'Checking'}
          </div>
          <button
            onClick={() => setShowHistory(true)}
            className="text-[10px] font-black uppercase tracking-widest px-3 py-1.5 rounded-full border-2 border-gray-700 text-gray-400 hover:border-yellow-500/50 hover:text-yellow-400 transition-all"
          >
            History
          </button>
        </div>

        {/* Right: Connect / Disconnect */}
        <div className="flex items-center gap-3">
          {isConnected ? (
            <button
              onClick={stopSession}
              className="text-xs font-black uppercase tracking-widest px-5 py-2 rounded-full border-2 border-yellow-500 text-yellow-400 hover:bg-yellow-500/10 transition-all flex items-center gap-2"
            >
              <Power className="w-5 h-5" strokeWidth={2.5} />
              <span className="hidden xs:inline">Disconnect</span>
            </button>
          ) : (
            <button
              onClick={startSession}
              disabled={isConnecting}
              className="text-xs font-black uppercase tracking-widest px-5 py-2 rounded-full bg-yellow-400 text-black hover:bg-yellow-300 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2 shadow-[0_0_15px_rgba(234,179,8,0.3)] border-2 border-black"
            >
              {isConnecting ? <Activity className="w-5 h-5 animate-spin" strokeWidth={2.5} /> : <Power className="w-5 h-5" strokeWidth={2.5} />}
              <span className="hidden xs:inline">{isConnecting ? 'Connecting…' : 'Connect'}</span>
            </button>
          )}
        </div>
      </header>

      {/* ══ Main content area ════════════════════════════════════════════════ */}
      <main className="flex-1 relative bg-black overflow-hidden flex flex-col items-center justify-center">
        {/* Video Background (Integrated) */}
        <div className={`absolute inset-0 z-0 transition-opacity duration-700 ${isConnected ? 'opacity-70' : 'opacity-30'}`}>
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="w-full h-full object-cover"
          />
        </div>

        {/* Hidden canvas for frame capture */}
        <canvas ref={canvasRef} className="hidden" />

        {/* ── Floating Overlays ── */}
        <div className="absolute inset-0 z-20 pointer-events-none p-4 sm:p-6 flex flex-col sm:flex-row justify-between gap-6">
          {/* Left Side: Empty (Scene & Alerts removed to clear view) */}
          <div className="flex flex-col gap-6 w-full sm:w-80">
          </div>

          {/* Right Side: Tactile Map (Optional on mobile) */}
          <div className="flex flex-col items-end justify-center sm:justify-start">
            {mapImageUrl && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-black/80 backdrop-blur-2xl rounded-2xl p-6 border-2 border-yellow-500/30 pointer-events-auto shadow-2xl"
              >
                <div className="text-sm font-black text-yellow-500 uppercase tracking-widest text-center mb-4 flex items-center gap-3 justify-center">
                  <MapIcon className="w-6 h-6" strokeWidth={3} />
                  <span>Tactile Map</span>
                </div>
                <img
                  src={mapImageUrl}
                  alt="AI-generated tactile map"
                  className="rounded-xl max-h-32 sm:max-h-48 max-w-[150px] sm:max-w-xs object-contain border-2 border-yellow-500/30"
                />
              </motion.div>
            )}
          </div>
        </div>

        {/* ── Center Content Overlay ── */}
        <div className="relative z-10 flex flex-col items-center gap-6 sm:gap-8 w-full max-w-2xl px-6">
          {/* ── Big Status Circle ── */}
          <div className="flex flex-col items-center gap-4">
            <div className="relative flex items-center justify-center">
              {/* Pulse rings for speaking state */}
              <AnimatePresence>
                {isConnected && isSpeaking && (
                  <>
                    <motion.div 
                      initial={{ scale: 0.8, opacity: 0 }}
                      animate={{ scale: 1.5, opacity: 0 }}
                      transition={{ duration: 1.5, repeat: Infinity }}
                      className="absolute w-48 sm:w-56 h-48 sm:h-56 rounded-full border-2 border-yellow-500/30" 
                    />
                    <motion.div 
                      initial={{ scale: 0.8, opacity: 0 }}
                      animate={{ scale: 1.5, opacity: 0 }}
                      transition={{ duration: 1.5, repeat: Infinity, delay: 0.5 }}
                      className="absolute w-48 sm:w-56 h-48 sm:h-56 rounded-full border-2 border-yellow-500/20" 
                    />
                  </>
                )}
              </AnimatePresence>

              <button
                onClick={handleToggleConnect}
                disabled={isConnecting}
                aria-label={isConnected ? 'Disconnect' : 'Connect to AI assistant'}
                className={`relative w-36 sm:w-44 h-36 sm:h-44 rounded-full flex flex-col items-center justify-center gap-2 transition-all duration-300 select-none shadow-2xl ${
                  status === SessionStatus.DISCONNECTED
                    ? 'border-4 border-yellow-500 bg-black/60 backdrop-blur-md hover:bg-yellow-900/20 hover:border-yellow-400 cursor-pointer active:scale-95'
                    : isConnecting
                    ? 'border-4 border-gray-600 bg-black/60 backdrop-blur-md cursor-not-allowed'
                    : isSpeaking
                    ? 'border-4 border-yellow-500 bg-black/60 backdrop-blur-md glow-yellow cursor-pointer'
                    : 'border-4 border-yellow-500 bg-black/60 backdrop-blur-md glow-yellow cursor-pointer'
                } ${status === SessionStatus.ERROR ? 'border-yellow-500 bg-red-900/20 glow-yellow' : ''}`}
              >
                {status === SessionStatus.DISCONNECTED && (
                  <>
                    <Play className="w-12 sm:w-14 h-12 sm:h-14 text-yellow-500 fill-yellow-500" strokeWidth={2.5} />
                    <span className="text-yellow-400 font-black text-xs uppercase tracking-widest">Tap to Start</span>
                  </>
                )}
                {isConnecting && (
                  <>
                    <Activity className="w-10 sm:w-12 h-10 sm:h-12 text-yellow-500 animate-spin" strokeWidth={2.5} />
                    <span className="text-gray-400 font-black text-xs uppercase tracking-widest">Connecting</span>
                  </>
                )}
                {isConnected && isSpeaking && (
                  <>
                    <Volume2 className="w-12 sm:w-14 h-12 sm:h-14 text-yellow-400" strokeWidth={2.5} />
                    <span className="text-yellow-400 font-black text-xs uppercase tracking-widest">AI Speaking</span>
                  </>
                )}
                {isConnected && !isSpeaking && (
                  <>
                    <Mic className={`w-12 sm:w-14 h-12 sm:h-14 text-yellow-400 ${inputVolume > 5 ? 'mic-pulse' : ''}`} strokeWidth={2.5} />
                    <span className="text-yellow-400 font-black text-xs uppercase tracking-widest">Listening</span>
                  </>
                )}
                {status === SessionStatus.ERROR && (
                  <>
                    <X className="w-12 sm:w-14 h-12 sm:h-14 text-yellow-500" strokeWidth={2.5} />
                    <span className="text-yellow-400 font-black text-xs uppercase tracking-widest">Error</span>
                  </>
                )}
              </button>
            </div>

            {/* Status badge */}
            {isConnected && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="px-8 py-3 rounded-full text-lg font-black uppercase tracking-widest bg-yellow-400 text-black shadow-2xl border-4 border-black"
              >
                AI Active
              </motion.div>
            )}

            {/* Volume visualizer */}
            {isConnected && (
              <div className="flex items-center gap-1.5 sm:gap-2 h-8 sm:h-10">
                {Array.from({ length: 20 }).map((_, i) => {
                  const barHeight = Math.min(40, Math.max(4, (inputVolume / 100) * 40 * (0.5 + Math.random() * 0.5)));
                  const isActive = inputVolume > (i / 20) * 50;
                  return (
                    <div
                      key={i}
                      className={`w-1 sm:w-1.5 rounded-full transition-all duration-75 ${isActive ? 'bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.5)]' : 'bg-gray-800'}`}
                      style={{ height: isActive ? `${barHeight}px` : '4px' }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </main>

      {/* ══ Floating urgent alert toast ══════════════════════════════════════ */}
      <AnimatePresence>
        {toastVisible && toastAlert && (
          <motion.div
            initial={{ opacity: 0, y: 50, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 50, x: '-50%' }}
            className="absolute bottom-8 left-1/2 max-w-lg w-[calc(100%-2rem)] sm:w-full px-4 z-40"
          >
              <div className={`rounded-2xl shadow-2xl px-8 py-6 flex items-start gap-6 border-4 backdrop-blur-xl ${
              toastAlert.urgent
                ? 'bg-red-950/95 border-red-500'
                : toastAlert.type === 'text'
                ? 'bg-yellow-950/95 border-yellow-500'
                : 'bg-gray-900/95 border-yellow-500'
            }`}>
              <span className={`text-4xl shrink-0 ${toastAlert.urgent ? 'text-red-400' : 'text-yellow-400'}`}>
                {toastAlert.urgent ? <AlertTriangle className="w-10 h-10" strokeWidth={3} /> : <Info className="w-10 h-10" strokeWidth={3} />}
              </span>
              <div className="flex-1">
                <div className={`text-xs font-black uppercase tracking-widest mb-2 ${toastAlert.urgent ? 'text-red-400' : 'text-yellow-400'}`}>
                  {toastAlert.urgent ? 'Urgent Alert' : toastAlert.type === 'text' ? 'Text Detected' : 'Alert'}
                </div>
                <p className="text-xl text-white leading-snug font-black tracking-wide">{toastAlert.message}</p>
              </div>
              <button
                onClick={() => setToastVisible(false)}
                className="text-gray-500 hover:text-white transition-colors"
                aria-label="Dismiss alert"
              >
                <X className="w-8 h-8" strokeWidth={3} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ══ History modal ════════════════════════════════════════════════════ */}
      {showHistory && <HistoryPanel onClose={() => setShowHistory(false)} />}
    </div>
  );
};

export default App;
