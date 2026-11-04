/** Suppress brief reads and keep adjacent operations in one quiet visual interval. */
export function createActivityIndicator(change:(visible:boolean)=>void,delay=400,minimum=900) {
  let active=false,visible=false,shownAt=0,disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
  const clear=()=>{if(timer!==undefined){clearTimeout(timer);timer=undefined;}};
  return {
    setActive(next:boolean){
      if(disposed||active===next)return;
      active=next;clear();
      if(active&&!visible)timer=setTimeout(()=>{timer=undefined;if(disposed||!active)return;visible=true;shownAt=Date.now();change(true);},delay);
      else if(!active&&visible)timer=setTimeout(()=>{timer=undefined;if(disposed||active)return;visible=false;change(false);},Math.max(0,minimum-(Date.now()-shownAt)));
    },
    dispose(){disposed=true;clear();},
  };
}
