// types.ts
import { Device } from 'mediasoup-client';

export interface PeerMedia {
  paused: boolean;
  [key: string]: any;
}

export interface PeerStats {
  [key: string]: any;
}

export interface PeerInfo {
  joinTs: number;
  media: { [mediaTag: string]: PeerMedia };
  stats: { [id: string]: PeerStats };
  consumerLayers: { [consumerId: string]: { currentLayer: number } };
}

export interface PeersState {
  [peerId: string]: PeerInfo;
}

export interface ActiveSpeaker {
  peerId?: string;
  volume?: number;
}

export interface ConsumerAppData {
  peerId: string;
  mediaTag: string;
}
