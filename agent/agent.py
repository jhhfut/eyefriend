"""
Be My AI — ADK Bidi-Streaming Vision Agent
==========================================
Real-time vision assistant for blind/low-vision users built with
Google Agent Development Kit (ADK) bidi-streaming.

Run locally (no GCP credits needed):
    pip install -r requirements.txt
    cp .env.example .env  # add your GEMINI_API_KEY
    python agent.py

The agent:
  - Streams live video frames + audio from the frontend
  - Proactively warns about obstacles, hazards, and text
  - Responds to natural voice questions
  - Logs session events to Firestore (or in-memory if no GCP project set)
"""

import os
import json
import asyncio
import base64
from datetime import datetime
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

import google.genai.types as genai_types
from google.adk.agents import LiveRequestQueue
from google.adk.agents.llm_agent import LlmAgent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.agents.run_config import RunConfig, StreamingMode

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# ── Configuration ─────────────────────────────────────────────────────────────

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GOOGLE_CLOUD_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
MODEL = "gemini-2.0-flash-live-001"
APP_NAME = "be-my-ai"
PORT = int(os.environ.get("PORT", 8081))

# ── Firestore (optional — falls back to in-memory) ────────────────────────────

firestore_db = None
if GOOGLE_CLOUD_PROJECT:
    try:
        from google.cloud import firestore
        firestore_db = firestore.Client(project=GOOGLE_CLOUD_PROJECT)
        print(f"Firestore connected: project={GOOGLE_CLOUD_PROJECT}")
    except Exception as e:
        print(f"Firestore unavailable ({e}), using in-memory storage")

# Simple in-memory fallback
_memory_sessions: dict[str, dict] = {}


async def _save_session(session_id: str, data: dict):
    if firestore_db:
        firestore_db.collection("adk_sessions").document(session_id).set(data)
    else:
        _memory_sessions[session_id] = data


async def _update_session(session_id: str, updates: dict):
    if firestore_db:
        from google.cloud.firestore import ArrayUnion, Increment
        firestore_db.collection("adk_sessions").document(session_id).update(updates)
    else:
        if session_id in _memory_sessions:
            _memory_sessions[session_id].update(updates)


# ── ADK Tool definitions ──────────────────────────────────────────────────────

def proactive_alert(message: str, urgent: bool, alert_type: str) -> dict:
    """
    Call this to proactively warn the user about something in their environment.
    Use IMMEDIATELY for obstacles, hazards, steps, traffic, or important text.

    Args:
        message: Clear, brief description of what was detected (e.g. "Step down at 2 o'clock")
        urgent: True for immediate safety hazards (obstacles, traffic, steps)
        alert_type: One of: 'hazard', 'info', 'text', 'object'

    Returns:
        Confirmation dict
    """
    print(f"[ALERT] urgent={urgent} type={alert_type}: {message}")
    return {
        "status": "delivered",
        "message": message,
        "urgent": urgent,
        "type": alert_type,
        "timestamp": datetime.utcnow().isoformat(),
    }


def update_scene_summary(description: str, hazards: list[str], text_visible: list[str]) -> dict:
    """
    Update the visual display with a summary of the current scene.
    Call every 10-15 seconds when in Explore mode to keep the display current.

    Args:
        description: 1-2 sentence overview of what the camera sees
        hazards: List of current hazards or obstacles (empty list if none)
        text_visible: List of any readable text visible in the scene

    Returns:
        Confirmation dict
    """
    print(f"[SCENE] {description} | hazards={hazards} | text={text_visible}")
    return {
        "status": "updated",
        "description": description,
        "hazards": hazards,
        "text_visible": text_visible,
    }


def generate_tactile_map(prompt: str) -> dict:
    """
    Request generation of a simplified overhead diagram of the environment.
    Use when the user asks for a layout overview or spatial map.

    Args:
        prompt: Description of the space to map (e.g. "Room with door on left, table in center, window ahead")

    Returns:
        Status dict — the frontend handles actual image generation
    """
    print(f"[MAP] Generating tactile map: {prompt}")
    return {
        "status": "requested",
        "prompt": prompt,
    }


# ── System prompt ─────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are a real-time AI vision assistant for visually impaired and blind users.
You receive a continuous live video feed from the user's front-facing camera.

YOUR CORE BEHAVIOUR:
- Scan every frame for hazards, obstacles, text, and important features
- Call proactive_alert() IMMEDIATELY when you detect anything relevant — do NOT wait to be asked
- Be brief and clear — the user cannot see, so your voice is their only visual channel

PROACTIVE ALERTS — call proactive_alert() without waiting when you see:
- Any obstacle within 2-3 steps (furniture, people, walls, poles)
- Steps or stairs (specify: up or down, how many if visible)
- Curbs, drop-offs, or uneven surfaces
- Doors (open/closed, which direction it swings)
- Moving hazards: people walking toward user, vehicles
- Important text: signs, labels, prices, warning notices, buttons
- Wet floor signs or hazardous surfaces

WHEN SPOKEN TO — answer naturally and immediately:
- "What's in front of me?" → describe path + call update_scene_summary()
- "Read this" or "What does it say?" → read ALL visible text aloud clearly
- "What is this?" or "What am I holding?" → identify and describe the object
- "Is it safe to walk forward?" → assess the immediate path honestly
- "How many steps?" → count precisely if visible
- "Where is the [thing]?" → give clock-position directions

COMMUNICATION RULES:
- Use clock positions: "obstacle at 10 o'clock", "exit at 3 o'clock"
- Distances in steps or feet (e.g. "about 3 steps ahead")
- Safety info FIRST, then context
- One thing at a time — don't overwhelm
- Be calm and reassuring
- Never say "I can see" — say "I detect" or "there is"
"""

# ── ADK Agent ─────────────────────────────────────────────────────────────────

vision_agent = LlmAgent(
    model=MODEL,
    name="vision_assistant",
    description="Real-time vision assistant for blind/low-vision users",
    instruction=SYSTEM_PROMPT,
    tools=[proactive_alert, update_scene_summary, generate_tactile_map],
)

session_service = InMemorySessionService()

runner = Runner(
    app_name=APP_NAME,
    agent=vision_agent,
    session_service=session_service,
)

# ── FastAPI + WebSocket server ────────────────────────────────────────────────

app = FastAPI(title="Be My AI — ADK Agent")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "agent": "vision_assistant", "model": MODEL, "adk": True}


@app.websocket("/ws/session/{session_id}")
async def websocket_session(websocket: WebSocket, session_id: str, mode: str = "explore"):
    """
    WebSocket endpoint for bidi-streaming with the ADK vision agent.

    Frontend sends JSON messages:
      { "type": "audio", "data": "<base64 PCM 16kHz>" }
      { "type": "video", "data": "<base64 JPEG>" }
      { "type": "text",  "data": "user message string" }

    Agent sends JSON messages:
      { "type": "audio",   "data": "<base64 PCM 24kHz>" }
      { "type": "alert",   "message": "...", "urgent": bool, "alert_type": "..." }
      { "type": "scene",   "description": "...", "hazards": [], "text_visible": [] }
      { "type": "map",     "prompt": "..." }
      { "type": "error",   "message": "..." }
    """
    await websocket.accept()
    print(f"[WS] Session connected: id={session_id} mode={mode}")

    # Create ADK session
    adk_session = await session_service.create_session(
        app_name=APP_NAME,
        user_id=session_id,
        session_id=session_id,
        state={"mode": mode},
    )

    # Save to Firestore / memory
    await _save_session(session_id, {
        "session_id": session_id,
        "mode": mode,
        "started_at": datetime.utcnow().isoformat(),
        "status": "active",
        "alerts_count": 0,
        "text_read_count": 0,
    })

    # ADK live request queue — we push audio/video frames here
    live_request_queue = LiveRequestQueue()

    async def receive_from_frontend():
        """Read messages from the browser and push into the ADK queue."""
        try:
            while True:
                raw = await websocket.receive_text()
                msg = json.loads(raw)
                msg_type = msg.get("type")
                data = msg.get("data", "")

                if msg_type == "audio":
                    blob = genai_types.Blob(
                        mime_type="audio/pcm;rate=16000",
                        data=base64.b64decode(data),
                    )
                    live_request_queue.send_realtime(blob)

                elif msg_type == "video":
                    blob = genai_types.Blob(
                        mime_type="image/jpeg",
                        data=base64.b64decode(data),
                    )
                    live_request_queue.send_realtime(blob)

                elif msg_type == "text":
                    live_request_queue.send_content(
                        genai_types.Content(
                            role="user",
                            parts=[genai_types.Part(text=data)],
                        )
                    )

                elif msg_type == "end":
                    live_request_queue.close()
                    break

        except WebSocketDisconnect:
            live_request_queue.close()

    async def send_to_frontend():
        """Stream ADK agent responses back to the browser."""
        run_config = RunConfig(
            streaming_mode=StreamingMode.BIDI,
            response_modalities=["AUDIO"],
            speech_config=genai_types.SpeechConfig(
                voice_config=genai_types.VoiceConfig(
                    prebuilt_voice_config=genai_types.PrebuiltVoiceConfig(
                        voice_name="Charon"
                    )
                )
            ),
        )

        async for event in runner.run_live(
            session_id=session_id,
            user_id=session_id,
            live_request_queue=live_request_queue,
            run_config=run_config,
        ):
            # Audio output → send to frontend for playback
            if event.content and event.content.parts:
                for part in event.content.parts:
                    if part.inline_data and part.inline_data.mime_type.startswith("audio"):
                        await websocket.send_json({
                            "type": "audio",
                            "data": base64.b64encode(part.inline_data.data).decode(),
                        })

            # Tool calls → relay structured data to frontend UI
            if event.get_function_calls():
                for fc in event.get_function_calls():
                    if fc.name == "proactive_alert":
                        await websocket.send_json({
                            "type": "alert",
                            "message": fc.args.get("message", ""),
                            "urgent": fc.args.get("urgent", False),
                            "alert_type": fc.args.get("alert_type", "info"),
                        })
                        await _update_session(session_id, {"alerts_count": (_memory_sessions.get(session_id, {}).get("alerts_count", 0) + 1)})

                    elif fc.name == "update_scene_summary":
                        await websocket.send_json({
                            "type": "scene",
                            "description": fc.args.get("description", ""),
                            "hazards": fc.args.get("hazards", []),
                            "text_visible": fc.args.get("text_visible", []),
                        })

                    elif fc.name == "generate_tactile_map":
                        await websocket.send_json({
                            "type": "map",
                            "prompt": fc.args.get("prompt", ""),
                        })

            # Interrupted → tell frontend to stop playing audio
            if hasattr(event, "interrupted") and event.interrupted:
                await websocket.send_json({"type": "interrupted"})

    try:
        await asyncio.gather(receive_from_frontend(), send_to_frontend())
    except Exception as e:
        print(f"[WS] Session error: {e}")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        await _update_session(session_id, {
            "status": "ended",
            "ended_at": datetime.utcnow().isoformat(),
        })
        print(f"[WS] Session closed: {session_id}")


@app.get("/api/sessions")
async def list_sessions():
    if firestore_db:
        docs = firestore_db.collection("adk_sessions").order_by(
            "started_at", direction="DESCENDING"
        ).limit(20).stream()
        return [{"id": d.id, **d.to_dict()} for d in docs]
    return list(_memory_sessions.values())


if __name__ == "__main__":
    print(f"Starting Be My AI ADK Agent on port {PORT}")
    print(f"Model: {MODEL}")
    print(f"Firestore: {'enabled' if firestore_db else 'in-memory fallback'}")
    print(f"WebSocket endpoint: ws://localhost:{PORT}/ws/session/{{session_id}}")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
