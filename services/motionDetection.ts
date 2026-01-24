// services/motionDetection.ts
export const getMotionScore = (current: Uint8ClampedArray, prev: Uint8ClampedArray): number => {
    let energy = 0;
    const step = 8; // Performance optimization
    const threshold = 25; // Noise Floor to break the 77% barrier
  
    for (let i = 0; i < current.length; i += 4 * step) {
      const rDiff = Math.abs(current[i] - prev[i]);
      const gDiff = Math.abs(current[i + 1] - prev[i + 1]);
      const bDiff = Math.abs(current[i + 2] - prev[i + 2]);
      const avgDiff = (rDiff + gDiff + bDiff) / 3;
      
      if (avgDiff > threshold) {
        energy += avgDiff;
      }
    }
    return energy / (current.length / (4 * step));
  };