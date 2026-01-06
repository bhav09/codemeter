export interface PairingRequest {
  type: 'pairing_request';
  nonce: string;
  timestamp: number;
}

export interface PairingResponse {
  type: 'pairing_response';
  nonce: string;
  sessionToken: string;
  userEmail?: string;
  timestamp: number;
}

export interface PairingConfirmation {
  type: 'pairing_confirmation';
  nonce: string;
  success: boolean;
  message: string;
}

export interface TokenRefresh {
  type: 'token_refresh';
  sessionToken: string;
  timestamp: number;
}

export interface ErrorMessage {
  type: 'error';
  error: string;
  timestamp: number;
}

export type Message = 
  | PairingRequest 
  | PairingResponse 
  | PairingConfirmation 
  | TokenRefresh 
  | ErrorMessage;
