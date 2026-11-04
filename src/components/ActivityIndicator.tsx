import {useEffect,useRef,useState} from "react";
import {createActivityIndicator} from "../lib/activityIndicator";

export function ActivityIndicator({active}:{active:boolean}) {
  const [visible,setVisible]=useState(false),controller=useRef<ReturnType<typeof createActivityIndicator>|null>(null);
  useEffect(()=>{setVisible(false);const current=createActivityIndicator(setVisible);controller.current=current;return()=>{current.dispose();controller.current=null;};},[]);
  useEffect(()=>{controller.current?.setActive(active);},[active]);
  return <div className={`progress-bar${visible?" is-visible":""}`} aria-hidden="true"/>;
}
