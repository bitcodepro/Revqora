import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {createActivityIndicator} from "./activityIndicator";
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>vi.useRealTimers());
it("does not flash for short reads or restart its timer on repeated progress updates",()=>{
 const change=vi.fn(),indicator=createActivityIndicator(change);
 indicator.setActive(true);vi.advanceTimersByTime(150);indicator.setActive(false);vi.advanceTimersByTime(500);expect(change).not.toHaveBeenCalled();
 indicator.setActive(true);vi.advanceTimersByTime(200);indicator.setActive(true);vi.advanceTimersByTime(200);expect(change.mock.calls).toEqual([[true]]);indicator.dispose();
});
it("keeps adjacent operations visible without a hide/show flash",()=>{
 const change=vi.fn(),indicator=createActivityIndicator(change);
 indicator.setActive(true);vi.advanceTimersByTime(400);indicator.setActive(false);vi.advanceTimersByTime(300);indicator.setActive(true);vi.advanceTimersByTime(700);expect(change.mock.calls).toEqual([[true]]);
 indicator.setActive(false);vi.advanceTimersByTime(0);expect(change.mock.calls).toEqual([[true],[false]]);indicator.dispose();
});
it("holds a visible indicator long enough to read and releases every timer on unmount",()=>{
 const change=vi.fn(),indicator=createActivityIndicator(change);
 indicator.setActive(true);vi.advanceTimersByTime(400);indicator.setActive(false);vi.advanceTimersByTime(899);expect(change.mock.calls).toEqual([[true]]);
 vi.advanceTimersByTime(1);expect(change.mock.calls).toEqual([[true],[false]]);
 indicator.setActive(true);indicator.dispose();vi.runAllTimers();expect(change).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
});
