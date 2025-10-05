// useMediaSoup.ts
import { useState, useEffect, useRef, useCallback } from 'react';
import * as mediasoup from 'mediasoup-client';
import type { ActiveSpeaker, ConsumerAppData, PeersState } from './types';
import type { Consumer, Producer, Transport } from 'mediasoup-client/types';

const uuidv4 = (): string => {
  return '111-111-1111'.replace(/[018]/g, () =>
    (crypto.getRandomValues(new Uint8Array(1))[0] & 15).toString(16)
  );
};

const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export const useMediaSoup = () => {
  const [myPeerId] = useState(() => uuidv4());
  const [device, setDevice] = useState<mediasoup.Device | null>(null);
  const [joined, setJoined] = useState(false);
  const [peers, setPeers] = useState<PeersState>({});
  const [activeSpeaker, setActiveSpeaker] = useState<ActiveSpeaker>({});
  const [isCamPaused, setIsCamPaused] = useState(false);
  const [isMicPaused, setIsMicPaused] = useState(false);
  const [isScreenPaused, setIsScreenPaused] = useState(false);
  const [isScreenAudioPaused, setIsScreenAudioPaused] = useState(false);

  const localCamRef = useRef<MediaStream | null>(null);
  const localScreenRef = useRef<MediaStream | null>(null);
  const recvTransportRef = useRef<Transport | null>(null);
  const sendTransportRef = useRef<Transport | null>(null);
  const camVideoProducerRef = useRef<Producer | null>(null);
  const camAudioProducerRef = useRef<Producer | null>(null);
  const screenVideoProducerRef = useRef<Producer | null>(null);
  const screenAudioProducerRef = useRef<Producer | null>(null);
  const consumersRef = useRef<Consumer[]>([]);
  const pollingIntervalRef = useRef<number | null>(null);

  // Signaling function
  const sig = useCallback(async (endpoint: string, data: any = {}, beacon = false) => {
    try {
      const headers = { 'Content-Type': 'application/json' };
      const body = JSON.stringify({ ...data, peerId: myPeerId });

      if (beacon) {
        navigator.sendBeacon('/signaling/' + endpoint, body);
        return null;
      }

      const response = await fetch('/signaling/' + endpoint, {
        method: 'POST',
        body,
        headers,
      });
      return await response.json();
    } catch (e) {
      console.error(e);
      return { error: e };
    }
  }, [myPeerId]);

  // Initialize device
  useEffect(() => {
    const initDevice = async () => {
      try {
        const newDevice = new mediasoup.Device();
        setDevice(newDevice);
      } catch (e: any) {
        if (e.name === 'UnsupportedError') {
          console.error('Browser not supported for video calls');
        } else {
          console.error(e);
        }
      }
    };

    initDevice();

    // Cleanup on unmount
    return () => {
      window.removeEventListener('unload', handleUnload);
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, []);

  const handleUnload = useCallback(() => {
    sig('leave', {}, true);
  }, [sig]);

  useEffect(() => {
    window.addEventListener('unload', handleUnload);
    return () => window.removeEventListener('unload', handleUnload);
  }, [handleUnload]);

  // Create transport
  const createTransport = useCallback(async (direction: 'send' | 'recv'): Promise<Transport | null> => {
    if (!device) return null;

    console.log(`Creating ${direction} transport`);
    const { transportOptions } = await sig('create-transport', { direction });

    let transport: Transport;
    if (direction === 'recv') {
      transport = await device.createRecvTransport(transportOptions);
    } else {
      transport = await device.createSendTransport(transportOptions);
    }

    transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      console.log('Transport connect event', direction);
      const { error } = await sig('connect-transport', {
        transportId: transportOptions.id,
        dtlsParameters,
      });
      if (error) {
        console.error('Error connecting transport', direction, error);
        return;
      }
      callback();
    });

    if (direction === 'send') {
      transport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
        console.log('Transport produce event', appData.mediaTag);
        let paused = false;
        if (appData.mediaTag === 'cam-video') paused = isCamPaused;
        if (appData.mediaTag === 'cam-audio') paused = isMicPaused;

        const { error, id } = await sig('send-track', {
          transportId: transportOptions.id,
          kind,
          rtpParameters,
          paused,
          appData,
        });

        if (error) {
          console.error('Error setting up server-side producer', error);
          errback(error);
          return;
        }
        callback({ id });
      });
    }

    transport.on('connectionstatechange', async (state) => {
      console.log(`Transport ${transport.id} connectionstatechange ${state}`);
      if (state === 'closed' || state === 'failed' || state === 'disconnected') {
        console.log('Transport closed, leaving room');
        await leaveRoom();
      }
    });

    return transport;
  }, [device, sig, isCamPaused, isMicPaused]);

  // Poll and update
  const pollAndUpdate = useCallback(async () => {
    const { peers: newPeers, activeSpeaker: newActiveSpeaker, error } = await sig('sync');
    if (error) return { error };

    setPeers(newPeers);
    setActiveSpeaker(newActiveSpeaker);

    // Check for peers that left
    Object.keys(peers).forEach((id) => {
      if (!newPeers[id]) {
        console.log(`Peer ${id} has exited`);
        consumersRef.current.forEach((consumer) => {
          if (consumer.appData.peerId === id) {
            closeConsumer(consumer);
          }
        });
      }
    });

    // Check for stopped media
    consumersRef.current.forEach((consumer) => {
      const { peerId, mediaTag } = consumer.appData;
      if (!newPeers[peerId as any]?.media[mediaTag as any]) {
        console.log(`Peer ${peerId} stopped transmitting ${mediaTag}`);
        closeConsumer(consumer);
      }
    });

    return {};
  }, [sig, peers]);

  // Join room
  const joinRoom = useCallback(async () => {
    if (joined || !device) return;

    console.log('Joining room');
    try {
      const { routerRtpCapabilities } = await sig('join-as-new-peer');
      if (!device.loaded) {
        await device.load({ routerRtpCapabilities });
      }
      setJoined(true);

      // Start polling
      pollingIntervalRef.current = setInterval(async () => {
        const { error } = await pollAndUpdate();
        if (error) {
          clearInterval(pollingIntervalRef.current!);
          console.error(error);
        }
      }, 1000);
    } catch (e) {
      console.error(e);
    }
  }, [joined, device, sig, pollAndUpdate]);

  // Start camera
  const startCamera = useCallback(async () => {
    if (localCamRef.current) return;

    console.log('Starting camera');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      localCamRef.current = stream;
      return stream;
    } catch (e) {
      console.error('Start camera error', e);
    }
  }, []);

  // Send camera streams
  const sendCameraStreams = useCallback(async () => {
    console.log('Sending camera streams');
    await joinRoom();
    const stream = await startCamera();
    if (!stream) return;

    if (!sendTransportRef.current) {
      sendTransportRef.current = await createTransport('send');
    }

    if (sendTransportRef.current) {
      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];

      camVideoProducerRef.current = await sendTransportRef.current.produce({
        track: videoTrack,
        encodings: [
          { maxBitrate: 96000, scaleResolutionDownBy: 4 },
          { maxBitrate: 680000, scaleResolutionDownBy: 1 },
        ],
        appData: { mediaTag: 'cam-video' },
      });

      if (isCamPaused) {
        await camVideoProducerRef.current.pause();
      }

      camAudioProducerRef.current = await sendTransportRef.current.produce({
        track: audioTrack,
        appData: { mediaTag: 'cam-audio' },
      });

      if (isMicPaused) {
        await camAudioProducerRef.current.pause();
      }
    }
  }, [joinRoom, startCamera, createTransport, isCamPaused, isMicPaused]);

  // Start screen share
  const startScreenshare = useCallback(async () => {
    console.log('Starting screen share');
    await joinRoom();

    if (!sendTransportRef.current) {
      sendTransportRef.current = await createTransport('send');
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      localScreenRef.current = stream;

      if (sendTransportRef.current) {
        const videoTrack = stream.getVideoTracks()[0];
        screenVideoProducerRef.current = await sendTransportRef.current.produce({
          track: videoTrack,
          encodings: [],
          appData: { mediaTag: 'screen-video' },
        });

        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length) {
          screenAudioProducerRef.current = await sendTransportRef.current.produce({
            track: audioTracks[0],
            appData: { mediaTag: 'screen-audio' },
          });
        }

        videoTrack.onended = async () => {
          console.log('Screen share stopped');
          await stopScreenshare();
        };
      }
    } catch (e) {
      console.error('Screen share error', e);
    }
  }, [joinRoom, createTransport]);

  // Stop screen share
  const stopScreenshare = useCallback(async () => {
    if (screenVideoProducerRef.current) {
      await sig('close-producer', { producerId: screenVideoProducerRef.current.id });
       screenVideoProducerRef.current.close();
      screenVideoProducerRef.current = null;
    }

    if (screenAudioProducerRef.current) {
      await sig('close-producer', { producerId: screenAudioProducerRef.current.id });
       screenAudioProducerRef.current.close();
      screenAudioProducerRef.current = null;
    }

    if (localScreenRef.current) {
      localScreenRef.current.getTracks().forEach((track) => track.stop());
      localScreenRef.current = null;
    }
  }, [sig]);

  // Subscribe to track
  const subscribeToTrack = useCallback(async (peerId: string, mediaTag: string) => {
    console.log('Subscribe to track', peerId, mediaTag);

    if (!recvTransportRef.current) {
      recvTransportRef.current = await createTransport('recv');
    }

    if (!device || !recvTransportRef.current) return;

    const consumerParameters = await sig('recv-track', {
      mediaTag,
      mediaPeerId: peerId,
      rtpCapabilities: device.rtpCapabilities,
    });

    const consumer = await recvTransportRef.current.consume({
      ...consumerParameters,
      appData: { peerId, mediaTag },
    });

    while (recvTransportRef.current.connectionState !== 'connected') {
      await sleep(100);
    }

    await sig('resume-consumer', { consumerId: consumer.id });
    await consumer.resume();

    consumersRef.current.push(consumer);
    return consumer;
  }, [device, createTransport, sig]);

  // Unsubscribe from track
  const unsubscribeFromTrack = useCallback(async (peerId: string, mediaTag: string) => {
    const consumer = consumersRef.current.find(
      (c) => (c.appData as any as ConsumerAppData).peerId === peerId && 
             (c.appData as any as ConsumerAppData).mediaTag === mediaTag
    );
    if (consumer) {
      await closeConsumer(consumer);
    }
  }, []);

  // Close consumer
  const closeConsumer = useCallback(async (consumer: Consumer) => {
    console.log('Closing consumer', consumer.id);
    await sig('close-consumer', { consumerId: consumer.id });
    consumer.close();
    consumersRef.current = consumersRef.current.filter((c) => c !== consumer);
  }, [sig]);

  // Stop all streams
  const stopStreams = useCallback(async () => {
    if (!sendTransportRef.current) return;

    console.log('Stopping media streams');
    await sig('close-transport', { transportId: sendTransportRef.current.id });
    sendTransportRef.current.close();

    sendTransportRef.current = null;
    camVideoProducerRef.current = null;
    camAudioProducerRef.current = null;
    screenVideoProducerRef.current = null;
    screenAudioProducerRef.current = null;

    if (localCamRef.current) {
      localCamRef.current.getTracks().forEach((track) => track.stop());
      localCamRef.current = null;
    }

    if (localScreenRef.current) {
      localScreenRef.current.getTracks().forEach((track) => track.stop());
      localScreenRef.current = null;
    }
  }, [sig]);

  // Leave room
  const leaveRoom = useCallback(async () => {
    if (!joined) return;

    console.log('Leaving room');
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
    }

    await sig('leave');

    if (recvTransportRef.current) {
      recvTransportRef.current.close();
      recvTransportRef.current = null;
    }

    if (sendTransportRef.current) {
      sendTransportRef.current.close();
      sendTransportRef.current = null;
    }

    camVideoProducerRef.current = null;
    camAudioProducerRef.current = null;
    screenVideoProducerRef.current = null;
    screenAudioProducerRef.current = null;
    consumersRef.current = [];

    if (localCamRef.current) {
      localCamRef.current.getTracks().forEach((track) => track.stop());
      localCamRef.current = null;
    }

    if (localScreenRef.current) {
      localScreenRef.current.getTracks().forEach((track) => track.stop());
      localScreenRef.current = null;
    }

    setPeers({});
    setJoined(false);
  }, [joined, sig]);

  // Toggle pause states
  const toggleCamPause = useCallback(async () => {
    const producer = camVideoProducerRef.current;
    if (!producer) return;

    if (isCamPaused) {
      await sig('resume-producer', { producerId: producer.id });
       producer.resume();
      setIsCamPaused(false);
    } else {
      await sig('pause-producer', { producerId: producer.id });
       producer.pause();
      setIsCamPaused(true);
    }
  }, [isCamPaused, sig]);

  const toggleMicPause = useCallback(async () => {
    const producer = camAudioProducerRef.current;
    if (!producer) return;

    if (isMicPaused) {
      await sig('resume-producer', { producerId: producer.id });
       producer.resume();
      setIsMicPaused(false);
    } else {
      await sig('pause-producer', { producerId: producer.id });
       producer.pause();
      setIsMicPaused(true);
    }
  }, [isMicPaused, sig]);

  return {
    myPeerId,
    joined,
    peers,
    activeSpeaker,
    consumers: consumersRef.current,
    isCamPaused,
    isMicPaused,
    isScreenPaused,
    isScreenAudioPaused,
    localCam: localCamRef.current,
    localScreen: localScreenRef.current,
    camVideoProducer: camVideoProducerRef.current,
    camAudioProducer: camAudioProducerRef.current,
    screenVideoProducer: screenVideoProducerRef.current,
    screenAudioProducer: screenAudioProducerRef.current,
    joinRoom,
    leaveRoom,
    sendCameraStreams,
    startScreenshare,
    stopScreenshare,
    subscribeToTrack,
    unsubscribeFromTrack,
    stopStreams,
    toggleCamPause,
    toggleMicPause,
    setIsCamPaused,
    setIsMicPaused,
  };
};