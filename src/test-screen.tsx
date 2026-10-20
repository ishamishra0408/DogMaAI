import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./test-screen.css";
function TestScreen() {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  async function start() {
    const player = video.current!;
    player.currentTime = 0;
    await player.play();
    setPlaying(true);
    try { await player.requestFullscreen(); } catch { /* Fullscreen can be blocked; playback still works. */ }
  }
  return <main><header><span>Camera test screen</span><a href="/">Back to manager</a></header><div className="test-player"><video ref={video} src="/demo.mp4" poster="/dog-poster.jpg" playsInline muted loop controls onPlay={() => setPlaying(true)} /></div><div className="test-controls"><div><h1>Point your phone at this screen.</h1><p>This kennel clip repeats. Use your phone’s rear camera to check the live connection and Liquid AI description.</p></div><button onClick={() => void start()}>{playing ? "Restart full screen" : "Play full screen"}</button></div><small>Sample footage: <a href="https://www.pexels.com/video/a-dog-is-in-a-cage-with-its-head-sticking-out-17747645/" target="_blank" rel="noreferrer">video by Nothing Ahead on Pexels</a>, free to use under the <a href="https://www.pexels.com/license/" target="_blank" rel="noreferrer">Pexels License</a>; converted to MP4 without sound and shown in greyscale. This is a screen test, not a live camera.</small></main>;
}
createRoot(document.getElementById("root")!).render(<TestScreen />);
