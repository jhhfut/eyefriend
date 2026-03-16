export enum SessionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}

export interface Alert {
  id: string;
  type: 'hazard' | 'info' | 'text' | 'object';
  message: string;
  timestamp: Date;
  urgent: boolean;
}

export interface SceneSummary {
  description: string;
  hazards: string[];
  textVisible: string[];
  updatedAt: Date;
}
