import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isActive: boolean;
  isUserTalking: boolean;
  isModelTalking: boolean;
  isMuted?: boolean;
}

const Visualizer: React.FC<VisualizerProps> = ({ isActive, isUserTalking, isModelTalking, isMuted }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    let offset = 0;

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const width = canvas.width;
      const height = canvas.height;
      const centerY = height / 2;
      
      offset += 0.15;

      if (isActive) {
        ctx.beginPath();
        ctx.lineWidth = 1.5;
        
        if (isMuted) {
          ctx.strokeStyle = '#ef4444'; // Red for muted
          ctx.shadowBlur = 2;
          ctx.shadowColor = '#ef4444';
          ctx.moveTo(0, centerY);
          ctx.lineTo(width, centerY);
        } else {
          ctx.strokeStyle = '#4ade80';
          ctx.shadowBlur = (isUserTalking || isModelTalking) ? 6 : 0;
          ctx.shadowColor = '#4ade80';
          
          for (let x = 0; x <= width; x += 1) {
            let amplitude = 0;
            if (isUserTalking || isModelTalking) {
              const baseAmp = isUserTalking ? 6 : 4;
              amplitude = Math.sin(x * 0.12 + offset) * baseAmp;
              amplitude += Math.sin(x * 0.2 - offset) * (baseAmp / 3);
            } else {
              // Idle subtle ripple
              amplitude = Math.sin(x * 0.05 + offset) * 0.5;
            }

            const y = centerY + amplitude;
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      } else {
        // Simple dim horizontal line when inactive
        ctx.beginPath();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#334155';
        ctx.moveTo(0, centerY);
        ctx.lineTo(width, centerY);
        ctx.stroke();
      }
      
      animationId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationId);
  }, [isActive, isUserTalking, isModelTalking, isMuted]);

  return (
    <canvas 
      ref={canvasRef} 
      width={120} 
      height={24} 
      className="transition-all duration-300"
    />
  );
};

export default Visualizer;