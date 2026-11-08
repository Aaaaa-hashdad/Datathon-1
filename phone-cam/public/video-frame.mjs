// Wait for a presented frame. A timeout lets the caller check for a source change
// without processing the previous frame again when the video stalls.
export function nextVideoFrame(video) {
  return new Promise((resolve) => {
    if (!video.requestVideoFrameCallback) {
      setTimeout(() => resolve({ mediaTime: video.currentTime }), 16);
      return;
    }
    const callback = video.requestVideoFrameCallback((_now, frame) => {
      clearTimeout(timer);
      resolve(frame);
    });
    const timer = setTimeout(() => {
      video.cancelVideoFrameCallback?.(callback);
      resolve(null);
    }, 200);
  });
}

// Anchor the media timeline to local wall time once per source. Subsequent frames
// keep their video spacing even if decoding or inference is delayed.
export function createVideoClock() {
  let lastVideo, lastSource, lastMediaTime, offset;
  return (video, frame) => {
    if (!Number.isFinite(frame?.mediaTime)) return null;
    const source = video.srcObject ?? video.currentSrc;
    const mediaTime = frame.mediaTime * 1000;
    if (video !== lastVideo || source !== lastSource || mediaTime < lastMediaTime) {
      const anchor = frame.captureTime ?? frame.presentationTime ?? performance.now();
      offset = performance.timeOrigin + anchor - mediaTime;
    } else if (mediaTime === lastMediaTime) return null;
    lastVideo = video;
    lastSource = source;
    lastMediaTime = mediaTime;
    return offset + mediaTime;
  };
}
