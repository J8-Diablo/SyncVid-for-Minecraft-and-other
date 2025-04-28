const socket = io();
let slavePlayer;
const displayId = parseInt(window.location.pathname.split('/').pop(), 10);

window.addEventListener('DOMContentLoaded', () => {
  slavePlayer = videojs('slaveVideo', { controls:false, fluid:false });
  socket.emit('registerDisplay', { id: displayId, width: window.innerWidth, height: window.innerHeight });
});

socket.on('controlEvent', ({ type, src, time }) => {
  if (type === 'load') {
    slavePlayer.src({ type:'video/webm', src });
    slavePlayer.ready(() => { slavePlayer.currentTime(0); slavePlayer.play(); });
  } else if (type === 'play') {
    slavePlayer.play();
  } else if (type === 'pause') {
    slavePlayer.pause();
  } else if (type === 'seek') {
    slavePlayer.currentTime(time);
  }
});

socket.on('frameUpdate', ({ id, x, y, width, height }) => {
  const int_id = parseInt(id, 10);
  if (int_id !== displayId) return;
  // x,y,width,height in % of container
  const W = window.innerWidth;
  const H = window.innerHeight;
  const scaleX = 100/width;
  const scaleY = 100/height;
  const offsetX = -x * (W/100) * scaleX;
  const offsetY = -y * (H/100) * scaleY;
  const vidEl = slavePlayer.el().querySelector('video');
  vidEl.style.transformOrigin='top left';
  vidEl.style.transform=`translate(${offsetX}px,${offsetY}px) scale(${scaleX},${scaleY})`;
});

setInterval(()=> socket.emit('reportTime',{ id:displayId, time:slavePlayer.currentTime() }),10000);
window.addEventListener('resize', ()=> socket.emit('registerDisplay',{ id:displayId, width:window.innerWidth, height:window.innerHeight }));
