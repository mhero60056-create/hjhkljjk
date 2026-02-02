
export interface TranscriptionEntry {
  role: 'user' | 'model';
  text: string;
}

export enum SessionStatus {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR',
}

export interface MouseCommand {
  action: 'move' | 'left_click' | 'right_click' | 'double_click' | 'scroll' | 'open' | 'none';
  direction: 'up' | 'down' | 'left' | 'right' | '';
  value: number;
  application: string;
}

export interface LiveConfig {
  model: string;
  systemInstruction?: string;
  voiceName: 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';
  isCameraEnabled: boolean;
  isScreenSharing: boolean;
  isMuted: boolean;
  isMouseMode: boolean;
}
