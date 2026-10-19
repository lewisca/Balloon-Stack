const M=require('matter-js'); const S=require('../src/sim.js');
let tot=0,bs=0,buckets={};
for(let seed=1;seed<=8;seed++){
 let x=seed*7919+13; const rng=()=>{x=(x*16807)%2147483647;return x/2147483647;};
 const ground=S.makeBalloons(rng,11), stack=[]; const eng=S.makeEngine(M), bodies=new Map();
 while(ground.length){
  const c=ground.shift(); const s=Math.floor(rng()*S.SLOTS);
  let w=0; for(let i=0;i<16;i++) if(S.rollout(M,stack,c,s,rng,150)) w++; const p=w/16;
  const xx=S.slotX(s,c.r); const b=S.bodyFor(M,c,xx,S.dropY(stack,xx,c.r),c.grip,c.bounce); c.x=xx; bodies.set(c.id,b); M.Composite.add(eng.world,b); stack.push(c);
  for(let i=0;i<210;i++) M.Engine.update(eng,1000/60); S.snapshot(stack,bodies);
  const o=stack.some(S.spilled)?0:1; tot++; bs+=(p-o)**2; const k=Math.min(4,Math.floor(p*5)); (buckets[k]=buckets[k]||[0,0,0]); buckets[k][0]++; buckets[k][1]+=p; buckets[k][2]+=o;
  if(!o) break;
 }
}
console.log('moves',tot,'brier',(bs/tot).toFixed(3));
for(const k in buckets){const[n,p,o]=buckets[k]; console.log(`bucket ${k*20}-${k*20+20}%: n=${n} predicted ${(p/n*100).toFixed(0)}% actual ${(o/n*100).toFixed(0)}%`);}
const brier = bs / tot, MAX = 0.08;
if (brier > MAX) { console.error(`FAIL: Brier ${brier.toFixed(3)} is above ${MAX}`); process.exit(1); }
console.log(`PASS: Brier ${brier.toFixed(3)} <= ${MAX}`);
