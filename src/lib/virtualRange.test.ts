import { expect, it, vi } from "vitest";
import { holdListFocus, virtualRange } from "./virtualRange";

it("keeps a shortened result set reachable when its old scroll offset is beyond the new end", () => {
  expect(virtualRange(2,56,400,12000)).toEqual({start:0,end:2});
  expect(virtualRange(0,56,400,12000)).toEqual({start:0,end:0});
  const range = virtualRange(20,56,400,12000);
  expect(range.start).toBe(7);
  expect(range.end).toBe(20);
});

it("preserves fractional wheel positions and bounded overscan without rendering the full list", () => {
  const range = virtualRange(10000,56,400,701.5);
  expect(range).toEqual({start:7,end:25});
  expect(virtualRange(20,56,400,-40).start).toBe(0);
});

it("moves focus from a row to the list before keyboard navigation scrolls that row away", () => {
  const row = {} as Element, outside = {} as Element;
  const list = { contains: (node: Element) => node === row, focus: vi.fn() };
  holdListFocus(list, row);
  expect(list.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  list.focus.mockClear();
  holdListFocus(list, list as unknown as Element);
  holdListFocus(list, outside);
  holdListFocus(list, null);
  expect(list.focus).not.toHaveBeenCalled();
});
