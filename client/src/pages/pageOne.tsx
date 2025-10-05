// pages/PageOne.tsx
import { useMediaSoup } from '../mediasoup';

function PageOne() {
  const {
    joined,
    myPeerId,
    peers,
    joinRoom,
    leaveRoom,
    sendCameraStreams,
    isCamPaused,
    toggleCamPause,
  } = useMediaSoup();

  return (
    <div className="page">
      <h1>Video Call Page</h1>
      <p>Peer ID: {myPeerId}</p>
      
      <div className="controls">
        {!joined ? (
          <button onClick={joinRoom}>Join Room</button>
        ) : (
          <>
            <button onClick={leaveRoom}>Leave Room</button>
            <button onClick={sendCameraStreams}>Send Camera</button>
            <button onClick={toggleCamPause}>
              {isCamPaused ? 'Unpause' : 'Pause'} Camera
            </button>
          </>
        )}
      </div>

      <div className="peers">
        <h3>Peers: {Object.keys(peers).length}</h3>
      </div>
    </div>
  );
}

export default PageOne;