
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, FunctionDeclaration, Type } from '@google/genai';
import { SessionStatus, LiveConfig, MouseCommand } from './types';
import { createBlob, decode, decodeAudioData } from './utils/audio-utils';
import Visualizer from './components/Visualizer';

// Use the correct native audio optimized model for Live API
const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';

const SET_MOUSE_CONTROL_TOOL: FunctionDeclaration = {
  name: 'set_mouse_control',
  description: 'Enable or disable the system-level mouse control mode based on user voice request.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      enabled: {
        type: Type.BOOLEAN,
        description: 'Whether to activate (true) or deactivate (false) mouse control mode.'
      }
    },
    required: ['enabled']
  }
};

const MOUSE_SYSTEM_INSTRUCTION = `You are an AI-powered Digital System Mouse Controller.
Your role is to act like the brain of a virtual mouse that controls the OPERATING SYSTEM.
Reply ONLY in valid JSON format for mouse actions.`;

const NORMAL_SYSTEM_INSTRUCTION = `You are a helpful, friendly assistant. 
Talk naturally and help the user. Keep responses conversational and brief.`;

const App: React.FC = () => {
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.IDLE);
  const [config, setConfig] = useState<LiveConfig>({
    model: MODEL_NAME,
    voiceName: 'Zephyr',
    isCameraEnabled: false,
    isScreenSharing: false,
    isMuted: false,
    isMouseMode: true,
    systemInstruction: MOUSE_SYSTEM_INSTRUCTION
  });
  
  const [isUserTalking, setIsUserTalking] = useState(false);
  const [isModelTalking, setIsModelTalking] = useState(false);
  const [lastCommand, setLastCommand] = useState<MouseCommand | null>(null);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');

  const isMutedRef = useRef(config.isMuted);

  useEffect(() => {
    isMutedRef.current = config.isMuted;
  }, [config.isMuted]);

  const sessionRef = useRef<any>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const audioContextRef = useRef<{ input: AudioContext; output: AudioContext } | null>(null);
  const audioNodesRef = useRef<{ source?: MediaStreamAudioSourceNode; processor?: ScriptProcessorNode } | null>(null);
  const nextStartTimeRef = useRef(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameIntervalRef = useRef<number | null>(null);
  const mediaRequestRef = useRef(0);

  const isJsonLike = (text: string) => {
    const trimmed = text.trim();
    return trimmed.startsWith('{') && trimmed.includes('"action"');
  };

  const applyMouseMode = useCallback((enabled: boolean) => {
    const nextInstruction = enabled ? MOUSE_SYSTEM_INSTRUCTION : NORMAL_SYSTEM_INSTRUCTION;
    setConfig(prev => ({ ...prev, isMouseMode: enabled, systemInstruction: nextInstruction }));
    if (status === SessionStatus.CONNECTED || status === SessionStatus.CONNECTING) {
      const wasCameraEnabled = config.isCameraEnabled;
      const wasScreenSharing = config.isScreenSharing;
      stopSession();
      setTimeout(() => startSession(wasCameraEnabled || wasScreenSharing, nextInstruction, enabled), 150);
    }
  }, [config.isCameraEnabled, config.isScreenSharing, status]);

  const toggleMouseMode = useCallback(() => {
    applyMouseMode(!config.isMouseMode);
  }, [config.isMouseMode, applyMouseMode]);

  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close?.();
      sessionRef.current = null;
    }
    sessionPromiseRef.current = null;
    if (audioNodesRef.current?.processor) audioNodesRef.current.processor.disconnect();
    if (audioNodesRef.current?.source) audioNodesRef.current.source.disconnect();
    audioSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    audioSourcesRef.current.clear();
    
    if (videoRef.current?.srcObject) {
      (videoRef.current.srcObject as MediaStream).getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
    
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    
    setStatus(SessionStatus.IDLE);
    setIsUserTalking(false);
    setIsModelTalking(false);
    setConfig(prev => ({ ...prev, isCameraEnabled: false, isScreenSharing: false }));
  }, []);

  const startSession = async (withVisual = false, instructionOverride?: string, isMouseModeOverride?: boolean) => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;
      setStatus(SessionStatus.CONNECTING);
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      if (!audioContextRef.current) {
        audioContextRef.current = {
          input: new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 }),
          output: new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 }),
        };
      }
      const { input: inputCtx, output: outputCtx } = audioContextRef.current;
      await inputCtx.resume();
      await outputCtx.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const sessionIsMouseMode = isMouseModeOverride !== undefined ? isMouseModeOverride : config.isMouseMode;
      const sessionInstruction = instructionOverride || config.systemInstruction;

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voiceName } } },
          systemInstruction: sessionInstruction,
          tools: [{ functionDeclarations: [SET_MOUSE_CONTROL_TOOL] }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(SessionStatus.CONNECTED);
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              if (isMutedRef.current) { setIsUserTalking(false); return; }
              const inputData = e.inputBuffer.getChannelData(0);
              const sum = inputData.reduce((a, b) => a + Math.abs(b), 0);
              setIsUserTalking(sum / inputData.length > 0.01);
              sessionPromise.then(s => s.sendRealtimeInput({ media: createBlob(inputData) })).catch(() => {});
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
            audioNodesRef.current = { source, processor: scriptProcessor };
            if (withVisual) {
               if (config.isScreenSharing) toggleScreenShare(true);
               else toggleCamera(true);
            }
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                if (fc.name === 'set_mouse_control') {
                  const { enabled } = fc.args as { enabled: boolean };
                  sessionPromise.then(session => {
                    session.sendToolResponse({
                      functionResponses: {
                        id: fc.id,
                        name: fc.name,
                        response: { status: 'success', message: `Mouse mode ${enabled ? 'activated' : 'deactivated'}` }
                      }
                    });
                  });
                  applyMouseMode(enabled);
                  return;
                }
              }
            }
            
            if (sessionIsMouseMode && message.serverContent?.modelTurn?.parts) {
              const textPart = message.serverContent.modelTurn.parts.find(p => p.text);
              if (textPart && textPart.text && isJsonLike(textPart.text)) {
                try {
                  const jsonMatch = textPart.text.match(/\{[\s\S]*\}/);
                  if (jsonMatch) {
                    const cmd = JSON.parse(jsonMatch[0]) as MouseCommand;
                    if (cmd.action && cmd.action !== 'none') {
                      setLastCommand(cmd);
                      setTimeout(() => setLastCommand(null), 3000);
                    }
                  }
                } catch(e) {}
              }
            }

            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              setIsModelTalking(true);
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const audioBuffer = await decodeAudioData(decode(audioData), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputCtx.destination);
              source.onended = () => {
                audioSourcesRef.current.delete(source);
                if (audioSourcesRef.current.size === 0) setIsModelTalking(false);
              };
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              audioSourcesRef.current.add(source);
            }
            if (message.serverContent?.interrupted) {
              audioSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              audioSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsModelTalking(false);
            }
          },
          onerror: () => stopSession(),
          onclose: () => stopSession(),
        },
      });
      sessionPromiseRef.current = sessionPromise;
      sessionRef.current = await sessionPromise;
    } catch (err) { setStatus(SessionStatus.IDLE); }
  };

  const startMediaStreaming = useCallback((stream: MediaStream) => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.play();
    }

    if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
    
    const ctx = canvasRef.current?.getContext('2d');
    frameIntervalRef.current = window.setInterval(() => {
      if (!videoRef.current || !canvasRef.current || status !== SessionStatus.CONNECTED) return;
      canvasRef.current.width = 640; 
      canvasRef.current.height = 480;
      ctx?.drawImage(videoRef.current, 0, 0, 640, 480);
      canvasRef.current.toBlob(blob => {
        if (blob && sessionPromiseRef.current) {
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64Data = (reader.result as string).split(',')[1];
            sessionPromiseRef.current?.then(session => session.sendRealtimeInput({ media: { data: base64Data, mimeType: 'image/jpeg' } }));
          };
          reader.readAsDataURL(blob);
        }
      }, 'image/jpeg', 0.5);
    }, 1000);

    // Track ending
    stream.getVideoTracks()[0].onended = () => {
       stopMediaTracks();
       setConfig(prev => ({ ...prev, isCameraEnabled: false, isScreenSharing: false }));
    };
  }, [status]);

  const stopMediaTracks = useCallback(() => {
    if (videoRef.current?.srcObject) {
      const oldStream = videoRef.current.srcObject as MediaStream;
      oldStream.getTracks().forEach(t => t.stop());
      videoRef.current.srcObject = null;
    }
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
  }, []);

  const toggleCamera = useCallback(async (forceEnable = false, specificMode?: 'user' | 'environment') => {
    const sequence = ++mediaRequestRef.current;
    const shouldEnable = forceEnable || !config.isCameraEnabled;
    const mode = specificMode || facingMode;
    
    stopMediaTracks();

    if (shouldEnable) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: mode } });
        if (sequence !== mediaRequestRef.current) { stream.getTracks().forEach(t => t.stop()); return; }
        startMediaStreaming(stream);
        setConfig(prev => ({ ...prev, isCameraEnabled: true, isScreenSharing: false }));
      } catch (err) { 
        setConfig(prev => ({ ...prev, isCameraEnabled: false })); 
      }
    } else { 
      setConfig(prev => ({ ...prev, isCameraEnabled: false })); 
    }
  }, [config.isCameraEnabled, status, facingMode, stopMediaTracks, startMediaStreaming]);

  const toggleScreenShare = useCallback(async (forceEnable = false) => {
    const sequence = ++mediaRequestRef.current;
    const shouldEnable = forceEnable || !config.isScreenSharing;
    
    stopMediaTracks();

    if (shouldEnable) {
      try {
        const stream = await (navigator.mediaDevices as any).getDisplayMedia({ video: true });
        if (sequence !== mediaRequestRef.current) { stream.getTracks().forEach((t: any) => t.stop()); return; }
        startMediaStreaming(stream);
        setConfig(prev => ({ ...prev, isScreenSharing: true, isCameraEnabled: false }));
      } catch (err) {
        setConfig(prev => ({ ...prev, isScreenSharing: false }));
      }
    } else {
      setConfig(prev => ({ ...prev, isScreenSharing: false }));
    }
  }, [config.isScreenSharing, status, stopMediaTracks, startMediaStreaming]);

  const flipCamera = useCallback(() => {
    const nextMode = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(nextMode);
    if (config.isCameraEnabled) toggleCamera(true, nextMode);
  }, [facingMode, config.isCameraEnabled, toggleCamera]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (key === 'enter') status === SessionStatus.CONNECTED ? stopSession() : startSession();
      else if (key === 'm') setConfig(prev => ({ ...prev, isMuted: !prev.isMuted }));
      else if (key === 'escape' && status === SessionStatus.CONNECTED) stopSession();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [status, stopSession]);

  return (
    <div className="flex flex-col items-center justify-center h-full w-full bg-[#f8fafc]">
      {/* Command Preview HUD */}
      <div className={`fixed top-10 left-1/2 -translate-x-1/2 z-50 transition-all duration-500 transform ${lastCommand ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 -translate-y-10 scale-95 pointer-events-none'}`}>
        <div className="bg-[#1a1d23] border border-white/10 rounded-2xl px-6 py-4 shadow-2xl flex items-center gap-4">
          <div className="w-10 h-10 bg-green-500/20 rounded-full flex items-center justify-center text-green-400">
             <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path></svg>
          </div>
          <div className="text-white font-medium uppercase tracking-wider text-xs">Executed: {lastCommand?.action}</div>
        </div>
      </div>

      {/* Media Preview (Camera or Screen) */}
      <div className={`fixed top-10 right-10 w-64 h-48 bg-[#1a1d23] rounded-[32px] overflow-hidden shadow-2xl border border-white/5 transition-all duration-500 ${(config.isCameraEnabled || config.isScreenSharing) ? 'opacity-100 scale-100' : 'opacity-0 scale-90 pointer-events-none'}`}>
        <video ref={videoRef} autoPlay playsInline muted className={`w-full h-full object-cover ${(facingMode === 'user' && config.isCameraEnabled) ? 'scale-x-[-1]' : ''}`} />
      </div>
      <canvas ref={canvasRef} className="hidden" />

      {/* Main Container */}
      <div className="relative flex flex-col items-center gap-4">
        {/* Floating MIC OFF Badge */}
        <div className={`transition-all duration-500 transform ${config.isMuted && status === SessionStatus.CONNECTED ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}`}>
          <div className="bg-red-500 text-white px-4 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest shadow-lg animate-pulse">Mic Muted</div>
        </div>

        <div className="toolbar-container rounded-[40px] flex items-center px-8 py-4 transition-all duration-500 ease-in-out border border-white/10 overflow-hidden">
          {/* Status Globe */}
          <div className={`transition-all duration-500 ${status === SessionStatus.CONNECTED ? (config.isMuted ? 'text-red-500' : 'glow-green') : 'text-gray-600'}`}>
             <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="1.5"></circle><path strokeWidth="1.2" d="M2 12h20M12 2a15.3 15.3 0 010 20"></path></svg>
          </div>
          
          <div className="separator"></div>
          
          {/* Visualizer */}
          <div className="flex items-center justify-center w-[120px]">
            <Visualizer isActive={status === SessionStatus.CONNECTED} isUserTalking={isUserTalking} isModelTalking={isModelTalking} isMuted={config.isMuted} />
          </div>

          <div className="separator"></div>

          {/* Controls */}
          <div className="flex items-center gap-5">
            <button onClick={status === SessionStatus.CONNECTED ? stopSession : () => startSession(false)} className={`w-9 h-9 flex items-center justify-center transition-all duration-300 rounded-full ${status === SessionStatus.CONNECTED ? 'bg-red-500 text-white' : 'icon-inactive hover:text-white'}`}>
              <svg className={`w-5 h-5 ${status === SessionStatus.CONNECTED ? 'rotate-[135deg]' : ''}`} fill="currentColor" viewBox="0 0 24 24"><path d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"></path></svg>
            </button>
            
            <button onClick={() => setConfig(prev => ({...prev, isMuted: !prev.isMuted}))} className={`transition-all duration-300 ${config.isMuted ? 'text-red-500 scale-110' : 'icon-inactive hover:text-white'}`}>
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {config.isMuted ? <path strokeWidth="2.5" d="M18.364 18.364l-12.728-12.728M9 9v3a3 3 0 005.121 2.121M15 9V5a3 3 0 10-6 0v1m10 11a7.003 7.003 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4" /> : <path strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-20a3 3 0 013 3v8a3 3 0 01-6 0V5a3 3 0 013-3z" />}
              </svg>
            </button>

            <button onClick={() => toggleCamera()} title="Toggle Camera" className={`transition-all duration-300 ${config.isCameraEnabled ? 'text-green-400' : 'icon-inactive hover:text-white'}`}>
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
            </button>

            <button onClick={() => toggleScreenShare()} title="Share Screen" className={`transition-all duration-300 ${config.isScreenSharing ? 'text-cyan-400 scale-110' : 'icon-inactive hover:text-white'}`}>
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </button>

            <button onClick={toggleMouseMode} title="Toggle Mouse Mode" className={`transition-all duration-300 ${config.isMouseMode ? 'text-blue-400' : 'icon-inactive hover:text-white'}`}>
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeWidth="2" d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5"></path></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
