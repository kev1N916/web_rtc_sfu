import express from "express"
import mediasoup from "mediasoup"
import config from "./config"
import { log, warn } from "console";
import { AppData, AudioLevelObserver, Consumer, Producer, Router, RouterRtpCapabilities, RouterRtpCodecCapability, Transport, TransportListenInfo, WebRtcServer, WebRtcServerOptions, WebRtcTransport, WebRtcTransportOptions, Worker, WorkerLogLevel, WorkerLogTag } from "mediasoup/types";
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

let worker: Worker, router: Router, audioLevelObserver: AudioLevelObserver, activeSpeakerObserver;

interface RoomState {
  peers: Record<string, any>;
  activeSpeaker: { producerId: string; volume: number; peerId: string };
  transports: Record<string, Transport>;
  producers: Producer[];
  consumers: Consumer[];
}


const roomState: RoomState = {
  peers: {},
  activeSpeaker: { producerId: "", volume: 0, peerId: "" },
  transports: {},
  producers: [],
  consumers: []
}

async function startMediasoup() {
  const worker = await mediasoup.createWorker(
    {
      logLevel: config.mediasoup.workerSettings.logLevel as WorkerLogLevel,
      logTags: config.mediasoup.workerSettings.logTags as WorkerLogTag[],
      disableLiburing: Boolean(config.mediasoup.workerSettings.disableLiburing)
    });

  worker.on('died', () => {
    console.error(
      'mediasoup Worker died, exiting  in 5 seconds... [pid:%d]', worker.pid);

    setTimeout(() => process.exit(1), 5000);
  });

  // Create a WebRtcServer in this Worker.
  if (process.env.MEDIASOUP_USE_WEBRTC_SERVER !== 'false') {
    // Each mediasoup Worker will run its own WebRtcServer, so those cannot
    // share the same listening ports. Hence we increase the value in config.js
    // for each Worker.
    const webRtcServerOptions = config.mediasoup.webRtcServerOptions as WebRtcServerOptions;

    const webRtcServer = await worker.createWebRtcServer(webRtcServerOptions);

    worker.appData.webRtcServer = webRtcServer;
  }

  const mediaCodecs = config.mediasoup.routerOptions.mediaCodecs as RouterRtpCodecCapability[];
  const router = await worker.createRouter({ mediaCodecs: mediaCodecs })

  // Create a mediasoup AudioLevelObserver.
  const audioLevelObserver = await router.createAudioLevelObserver(
    {
      maxEntries: 1,
      threshold: -80,
      interval: 800
    });

  audioLevelObserver.on('volumes', (volumes) => {
    const { producer, volume } = volumes[0];
    log('audio-level volumes event', producer.appData.peerId, volume);
    roomState.activeSpeaker.producerId = producer.id;
    roomState.activeSpeaker.volume = volume;
    roomState.activeSpeaker.peerId = producer.appData.peerId as string;
  });
  audioLevelObserver.on('silence', () => {
    log('audio-level silence event');
    roomState.activeSpeaker.producerId = "";
    roomState.activeSpeaker.volume = 0;
    roomState.activeSpeaker.peerId = "";
  });

  return { worker, router, audioLevelObserver }
}
async function run() {

  ({ worker, router, audioLevelObserver } = await startMediasoup());

}

run()

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

// --> /signaling/sync
//
// client polling endpoint. send back our 'peers' data structure and
// 'activeSpeaker' info
//
app.post('/signaling/sync', async (req, res) => {
  let { peerId } = req.body;
  try {
    // make sure this peer is connected. if we've disconnected the
    // peer because of a network outage we want the peer to know that
    // happened, when/if it returns
    if (!roomState.peers[peerId]) {
      throw new Error('not connected');
    }

    // update our most-recently-seem timestamp -- we're not stale!
    roomState.peers[peerId].lastSeenTs = Date.now();

    res.send({
      peers: roomState.peers,
      activeSpeaker: roomState.activeSpeaker
    });
  } catch (e: any) {
    console.error(e.message);
    res.send({ error: e.message });
  }
});

// --> /signaling/join-as-new-peer
//
// adds the peer to the roomState data structure and creates a
// transport that the peer will use for receiving media. returns
// router rtpCapabilities for mediasoup-client device initialization
//
app.post('/signaling/join-as-new-peer', async (req, res) => {
  try {
    let { peerId } = req.body,
      now = Date.now();
    log('join-as-new-peer', peerId);

    roomState.peers[peerId] = {
      joinTs: now,
      lastSeenTs: now,
      media: {}, consumerLayers: {}, stats: {}
    };

    res.send({ routerRtpCapabilities: router.rtpCapabilities });
  } catch (e) {
    console.error('error in /signaling/join-as-new-peer', e);
    res.send({ error: e });
  }
});

// --> /signaling/leave
//
// removes the peer from the roomState data structure and and closes
// all associated mediasoup objects
//
app.post('/signaling/leave', async (req, res) => {
  try {
    let { peerId } = req.body;
    log('leave', peerId);

    closePeer(peerId);
    res.send({ left: true });
  } catch (e) {
    console.error('error in /signaling/leave', e);
    res.send({ error: e });
  }
});

function closePeer(peerId: any) {
  log('closing peer', peerId);
  for (let [id, transport] of Object.entries(roomState.transports)) {
    if (transport.appData.peerId === peerId) {
      closeTransport(transport);
    }
  }
  delete roomState.peers[peerId];
}

async function closeTransport(transport: Transport) {
  try {
    log('closing transport', transport.id, transport.appData);

    // our producer and consumer event handlers will take care of
    // calling closeProducer() and closeConsumer() on all the producers
    // and consumers associated with this transport
    transport.close();

    // so all we need to do, after we call transport.close(), is update
    // our roomState data structure
    delete roomState.transports[transport.id];
  } catch (e) {
    console.error(e);
  }
}

async function closeProducer(producer: Producer) {
  log('closing producer', producer.id, producer.appData);
  try {
    producer.close();

    // remove this producer from our roomState.producers list
    roomState.producers = roomState.producers
      .filter((p) => p.id !== producer.id);

    // remove this track's info from our roomState...mediaTag bookkeeping
    if (roomState.peers[producer.appData.peerId as string]) {
      delete (roomState.peers[producer.appData.peerId as string]
        .media[producer.appData.mediaTag as any]);
    }
  } catch (e) {
    console.error(e);
  }
}

async function closeConsumer(consumer: Consumer) {
  log('closing consumer', consumer.id, consumer.appData);
  consumer.close();

  // remove this consumer from our roomState.consumers list
  roomState.consumers = roomState.consumers.filter((c) => c.id !== consumer.id);

  // remove layer info from from our roomState...consumerLayers bookkeeping
  if (roomState.peers[consumer.appData.peerId as string]) {
    delete roomState.peers[consumer.appData.peerId as string].consumerLayers[consumer.id];
  }
}

// --> /signaling/create-transport
//
// create a mediasoup transport object and send back info needed
// to create a transport object on the client side
//
app.post('/signaling/create-transport', async (req, res) => {
  try {
    let { peerId, direction } = req.body;
    log('create-transport', peerId, direction);

    let transport = await createWebRtcTransport(peerId, direction);
    roomState.transports[transport.id] = transport;

    let { id, iceParameters, iceCandidates, dtlsParameters } = transport;
    res.send({
      transportOptions: { id, iceParameters, iceCandidates, dtlsParameters }
    });
  } catch (e) {
    console.error('error in /signaling/create-transport', e);
    res.send({ error: e });
  }
});

async function createWebRtcTransport(peerId: any, direction: any): Promise<WebRtcTransport<AppData>> {
  const server = worker.appData.webRtcServer as WebRtcServer
  const transport =
    await router.createWebRtcTransport({
      iceConsentTimeout: 20,
      webRtcServer: server,
      appData: { peerId: peerId, clientDirection: direction }
    });

  return transport
}

// --> /signaling/connect-transport
//
// called from inside a client's `transport.on('connect')` event
// handler.
//
app.post('/signaling/connect-transport', async (req, res) => {
  try {
    let { peerId, transportId, dtlsParameters } = req.body,
      transport = roomState.transports[transportId] as Transport;

    if (!transport) {
      console.error(`connect-transport: server-side transport ${transportId} not found`);
      res.send({ error: `server-side transport ${transportId} not found` });
      return;
    }

    log('connect-transport', peerId, transport.appData);

    await transport.connect({ dtlsParameters: dtlsParameters });
    res.send({ connected: true });
  } catch (e) {
    console.error('error in /signaling/connect-transport', e);
    res.send({ error: e });
  }
});

// --> /signaling/close-transport
//
// called by a client that wants to close a single transport (for
// example, a client that is no longer sending any media).
//
app.post('/signaling/close-transport', async (req, res) => {
  try {
    let { peerId, transportId } = req.body,
      transport = roomState.transports[transportId] as Transport;

    if (!transport) {
      console.error(`close-transport: server-side transport ${transportId} not found`);
      res.send({ error: `server-side transport ${transportId} not found` });
      return;
    }

    log('close-transport', peerId, transport.appData);

    await closeTransport(transport);
    res.send({ closed: true });
  } catch (e: any) {
    console.error('error in /signaling/close-transport', e);
    res.send({ error: e.message });
  }
});

// --> /signaling/close-producer
//
// called by a client that is no longer sending a specific track
//
app.post('/signaling/close-producer', async (req, res) => {
  try {
    let { peerId, producerId } = req.body,
      producer = roomState.producers.find((p) => p.id === producerId) as Producer;

    if (!producer) {
      console.error(`close-producer: server-side producer ${producerId} not found`);
      res.send({ error: `server-side producer ${producerId} not found` });
      return;
    }

    log('close-producer', peerId, producer.appData);

    await closeProducer(producer);
    res.send({ closed: true });
  } catch (e: any) {
    console.error(e);
    res.send({ error: e.message });
  }
});

// --> /signaling/send-track
//
// called from inside a client's `transport.on('produce')` event handler.
//
app.post('/signaling/send-track', async (req, res) => {
  try {
    let { peerId, transportId, kind, rtpParameters,
      paused = false, appData } = req.body,
      transport = roomState.transports[transportId] as Transport;

    if (!transport) {
      console.error(`send-track: server-side transport ${transportId} not found`);
      res.send({ error: `server-side transport ${transportId} not found` });
      return;
    }

    let producer = await transport.produce({
      kind,
      rtpParameters,
      paused,
      appData: { ...appData, peerId, transportId }
    });

    // if our associated transport closes, close ourself, too
    producer.on('transportclose', () => {
      log('producer\'s transport closed', producer.id);
      closeProducer(producer);
    });

    // monitor audio level of this producer. we call addProducer() here,
    // but we don't ever need to call removeProducer() because the core
    // AudioLevelObserver code automatically removes closed producers
    if (producer.kind === 'audio') {
      audioLevelObserver.addProducer({ producerId: producer.id });
    }

    roomState.producers.push(producer);
    roomState.peers[peerId].media[appData.mediaTag] = {
      paused,
      encodings: rtpParameters.encodings
    };

    res.send({ id: producer.id });
  } catch (e) {
  }
});

// --> /signaling/recv-track
//
// create a mediasoup consumer object, hook it up to a producer here
// on the server side, and send back info needed to create a consumer
// object on the client side. always start consumers paused. client
// will request media to resume when the connection completes
//
app.post('/signaling/recv-track', async (req, res) => {
  try {
    let { peerId, mediaPeerId, mediaTag, rtpCapabilities } = req.body;

    let producer = roomState.producers.find(
      (p) => p.appData.mediaTag === mediaTag &&
        p.appData.peerId === mediaPeerId
    );

    if (!producer) {
      let msg = 'server-side producer for ' +
        `${mediaPeerId}:${mediaTag} not found`;
      console.error('recv-track: ' + msg);
      res.send({ error: msg });
      return;
    }

    if (!router.canConsume({
      producerId: producer.id,
      rtpCapabilities
    })) {
      let msg = `client cannot consume ${mediaPeerId}:${mediaTag}`;
      console.error(`recv-track: ${peerId} ${msg}`);
      res.send({ error: msg });
      return;
    }

    let transport = Object.values(roomState.transports).find((t) =>
      t.appData.peerId === peerId && t.appData.clientDirection === 'recv'
    );

    if (!transport) {
      let msg = `server-side recv transport for ${peerId} not found`;
      console.error('recv-track: ' + msg);
      res.send({ error: msg });
      return;
    }

    let consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: true, // see note above about always starting paused
      appData: { peerId, mediaPeerId, mediaTag }
    });

    // need both 'transportclose' and 'producerclose' event handlers,
    // to make sure we close and clean up consumers in all
    // circumstances
    consumer.on('transportclose', () => {
      log(`consumer's transport closed`, consumer.id);
      closeConsumer(consumer);
    });
    consumer.on('producerclose', () => {
      log(`consumer's producer closed`, consumer.id);
      closeConsumer(consumer);
    });

    // stick this consumer in our list of consumers to keep track of,
    // and create a data structure to track the client-relevant state
    // of this consumer
    roomState.consumers.push(consumer);
    roomState.peers[peerId].consumerLayers[consumer.id] = {
      currentLayer: null,
      clientSelectedLayer: null
    };

    // update above data structure when layer changes.
    consumer.on('layerschange', (layers) => {
      log(`consumer layerschange ${mediaPeerId}->${peerId}`, mediaTag, layers);
      if (roomState.peers[peerId] &&
        roomState.peers[peerId].consumerLayers[consumer.id]) {
        roomState.peers[peerId].consumerLayers[consumer.id]
          .currentLayer = layers && layers.spatialLayer;
      }
    });

    res.send({
      producerId: producer.id,
      id: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerPaused: consumer.producerPaused
    });
  } catch (e) {
    console.error('error in /signaling/recv-track', e);
    res.send({ error: e });
  }
});

// --> /signaling/pause-consumer
//
// called to pause receiving a track for a specific client
//
app.post('/signaling/pause-consumer', async (req, res) => {
  try {
    let { peerId, consumerId } = req.body,
      consumer = roomState.consumers.find((c) => c.id === consumerId);

    if (!consumer) {
      console.error(`pause-consumer: server-side consumer ${consumerId} not found`);
      res.send({ error: `server-side producer ${consumerId} not found` });
      return;
    }

    log('pause-consumer', consumer.appData);

    await consumer.pause();

    res.send({ paused: true });
  } catch (e) {
    console.error('error in /signaling/pause-consumer', e);
    res.send({ error: e });
  }
});

// --> /signaling/resume-consumer
//
// called to resume receiving a track for a specific client
//
app.post('/signaling/resume-consumer', async (req, res) => {
  try {
    let { peerId, consumerId } = req.body,
      consumer = roomState.consumers.find((c) => c.id === consumerId);

    if (!consumer) {
      console.error(`pause-consumer: server-side consumer ${consumerId} not found`);
      res.send({ error: `server-side consumer ${consumerId} not found` });
      return;
    }

    log('resume-consumer', consumer.appData);

    await consumer.resume();

    res.send({ resumed: true });
  } catch (e) {
    console.error('error in /signaling/resume-consumer', e);
    res.send({ error: e });
  }
});

// --> /signalign/close-consumer
//
// called to stop receiving a track for a specific client. close and
// clean up consumer object
//
app.post('/signaling/close-consumer', async (req, res) => {
  try {
    let { peerId, consumerId } = req.body,
      consumer = roomState.consumers.find((c) => c.id === consumerId);

    if (!consumer) {
      console.error(`close-consumer: server-side consumer ${consumerId} not found`);
      res.send({ error: `server-side consumer ${consumerId} not found` });
      return;
    }

    await closeConsumer(consumer);

    res.send({ closed: true });
  } catch (e) {
    console.error('error in /signaling/close-consumer', e);
    res.send({ error: e });
  }
});

// --> /signaling/consumer-set-layers
//
// called to set the largest spatial layer that a specific client
// wants to receive
//
app.post('/signaling/consumer-set-layers', async (req, res) => {
  try {
    let { peerId, consumerId, spatialLayer } = req.body,
      consumer = roomState.consumers.find((c) => c.id === consumerId);

    if (!consumer) {
      console.error(`consumer-set-layers: server-side consumer ${consumerId} not found`);
      res.send({ error: `server-side consumer ${consumerId} not found` });
      return;
    }

    log('consumer-set-layers', spatialLayer, consumer.appData);

    await consumer.setPreferredLayers({ spatialLayer });

    res.send({ layersSet: true });
  } catch (e) {
    console.error('error in /signaling/consumer-set-layers', e);
    res.send({ error: e });
  }
});

// --> /signaling/pause-producer
//
// called to stop sending a track from a specific client
//
app.post('/signaling/pause-producer', async (req, res) => {
  try {
    let { peerId, producerId } = req.body,
      producer = roomState.producers.find((p) => p.id === producerId);

    if (!producer) {
      console.error(`pause-producer: server-side producer ${producerId} not found`);
      res.send({ error: `server-side producer ${producerId} not found` });
      return;
    }

    log('pause-producer', producer.appData);

    await producer.pause();

    roomState.peers[peerId].media[producer.appData.mediaTag as any].paused = true;

    res.send({ paused: true });
  } catch (e) {
    console.error('error in /signaling/pause-producer', e);
    res.send({ error: e });
  }
});

// --> /signaling/resume-producer
//
// called to resume sending a track from a specific client
//
app.post('/signaling/resume-producer', async (req, res) => {
  try {
    let { peerId, producerId } = req.body,
      producer = roomState.producers.find((p) => p.id === producerId);

    if (!producer) {
      console.error(`resume-producer: server-side producer ${producerId} not found`);
      res.send({ error: `server-side producer ${producerId} not found` });
      return;
    }

    log('resume-producer', producer.appData);

    await producer.resume();

    roomState.peers[peerId].media[producer.appData.mediaTag as any].paused = false;

    res.send({ resumed: true });
  } catch (e) {
    console.error('error in /signaling/resume-producer', e);
    res.send({ error: e });
  }
});

//
// stats
//
async function updatePeerStats() {
  for (let producer of roomState.producers) {
    if (producer.kind !== 'video') {
      continue;
    }
    try {
      let stats = await producer.getStats(),
        peerId = producer.appData.peerId;
      roomState.peers[peerId as any].stats[producer.id] = stats.map((s) => ({
        bitrate: s.bitrate,
        fractionLost: s.fractionLost,
        jitter: s.jitter,
        score: s.score,
        rid: s.rid
      }));
    } catch (e) {
      warn('error while updating producer stats', e);
    }
  }

  for (let consumer of roomState.consumers) {
    try {
      let stats = (await consumer.getStats())
        .find((s) => s.type === 'outbound-rtp'),
        peerId = consumer.appData.peerId;
      if (!stats || !roomState.peers[peerId as any]) {
        continue;
      }
      roomState.peers[peerId as any].stats[consumer.id] = {
        bitrate: stats.bitrate,
        fractionLost: stats.fractionLost,
        score: stats.score
      }
    } catch (e) {
      warn('error while updating consumer stats', e);
    }
  }
}