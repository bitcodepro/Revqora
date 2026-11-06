// Native wheel input at both boundaries, including rerenders near the last row.
export async function branchScrollBoundary(page) {
  const list=page.getByRole("listbox",{name:"Branches",exact:true});
  const policy=await list.evaluate(node=>getComputedStyle(node).overscrollBehaviorY);
  if(policy!=="none")throw Error("Branch scrolling still permits a local overscroll affordance");
  await list.hover();
  for(const edge of ["bottom","top"]){
    await list.evaluate((node,edge)=>{const max=node.scrollHeight-node.clientHeight;node.scrollTop=edge==="bottom"?Math.max(0,max-500):Math.min(max,500);},edge);
    await page.mouse.wheel(0,edge==="bottom"?1500:-1500);
    await page.waitForFunction(edge=>{const node=document.querySelector(".bm-viewport"),max=node.scrollHeight-node.clientHeight;return Math.abs(node.scrollTop-(edge==="bottom"?max:0))<=1;},edge);
    await list.evaluate(node=>{
      const samples=[];node.__boundarySamples=samples;node.__boundaryRecording=true;
      const frame=()=>{if(!node.__boundaryRecording)return;samples.push({top:node.scrollTop,extent:node.scrollHeight,viewport:node.clientHeight});requestAnimationFrame(frame);};requestAnimationFrame(frame);
    });
    try{
      for(let i=0;i<12;i++){
        await page.mouse.wheel(0,edge==="bottom"?120:-120);
        await list.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      }
      const samples=await list.evaluate(node=>{node.__boundaryRecording=false;return node.__boundarySamples;});
      if(samples.length<12)throw Error("Boundary scrolling was not sampled across rendered frames");
      if(samples.some(s=>Math.abs(s.top-(edge==="bottom"?s.extent-s.viewport:0))>1))throw Error(`${edge} boundary moved while scrolling past the end: ${JSON.stringify(samples)}`);
      if(new Set(samples.map(s=>`${s.extent}:${s.viewport}`)).size!==1)throw Error("Virtual row updates changed the scroll extent at a boundary");
      const visible=await list.evaluate((node,edge)=>{
        const options=node.querySelectorAll('[role="option"]'),row=options[edge==="bottom"?options.length-1:0];
        if(!row)return false;const r=row.getBoundingClientRect(),v=node.getBoundingClientRect();return r.bottom>v.top&&r.top<v.bottom;
      },edge);
      if(!visible)throw Error(`The ${edge} row is rendered outside the viewport`);
      if(await list.locator('[role="option"]').count()>50)throw Error("Boundary scrolling disabled virtualization");
    }finally{await list.evaluate(node=>{node.__boundaryRecording=false;delete node.__boundarySamples;});}
  }
}
