import {beforeEach,describe,expect,it,vi} from "vitest";
const stubs=vi.hoisted(()=>({listen:vi.fn(),install:vi.fn(),check:vi.fn()}));
vi.mock("@tauri-apps/api/event",()=>({listen:stubs.listen}));
vi.mock("./api",()=>({api:{updateInstall:stubs.install,updateCheck:stubs.check},errorMessage:(e:unknown)=>e instanceof Error?e.message:String(e)}));
import {useUpdate} from "./update";

beforeEach(()=>{vi.resetAllMocks();stubs.listen.mockResolvedValue(vi.fn());stubs.install.mockResolvedValue(undefined);useUpdate.setState({phase:"idle",info:null,error:null,progress:0,checkedAt:null});});
describe("update lifecycle",()=>{
 it("recovers from progress-listener registration failure before installing",async()=>{
  stubs.listen.mockRejectedValueOnce(Error("Progress bridge unavailable"));
  await expect(useUpdate.getState().install()).resolves.toBeUndefined();
  expect(stubs.install).not.toHaveBeenCalled();expect(useUpdate.getState().phase).toBe("error");expect(useUpdate.getState().error).toContain("Progress bridge unavailable");
  await useUpdate.getState().install();expect(stubs.install).toHaveBeenCalledTimes(1);expect(useUpdate.getState().phase).toBe("ready");
 });
 it("dispatches one installation when two callers arrive before listener setup completes",async()=>{
  let release!:()=>void;stubs.install.mockReturnValue(new Promise<void>(resolve=>{release=resolve;}));
  const first=useUpdate.getState().install(),second=useUpdate.getState().install();
  await vi.waitFor(()=>expect(stubs.install).toHaveBeenCalled());
  release();await Promise.all([first,second]);expect(stubs.install).toHaveBeenCalledTimes(1);expect(stubs.listen).toHaveBeenCalledTimes(1);
 });
 it("does not let an in-flight release check overlap installation or regress its phase",async()=>{
  let release!:(value:null)=>void;stubs.check.mockReturnValue(new Promise<null>(resolve=>{release=resolve;}));
  const checking=useUpdate.getState().check(true);await useUpdate.getState().install();
  const calls=stubs.install.mock.calls.length;release(null);await checking;
  expect(calls).toBe(0);expect(useUpdate.getState().phase).toBe("idle");
  await useUpdate.getState().install();expect(stubs.install).toHaveBeenCalledTimes(1);
 });
 it("ignores already-queued progress after the installation has completed",async()=>{
  let progress!:(e:{payload:{downloaded:number;total:number}})=>void;const unlisten=vi.fn();
  stubs.listen.mockImplementation(async(_event,callback)=>{progress=callback;return unlisten;});
  await useUpdate.getState().install();expect(unlisten).toHaveBeenCalledTimes(1);expect(useUpdate.getState().phase).toBe("ready");
  progress({payload:{downloaded:1,total:100}});expect(useUpdate.getState().phase).toBe("ready");expect(useUpdate.getState().progress).toBe(1);
 });
});
