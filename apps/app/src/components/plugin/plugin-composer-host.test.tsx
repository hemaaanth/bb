// @vitest-environment jsdom

import { useEffect } from "react";
import { createComposerBeforeSubmit } from "@get-bb/plugin-sdk/internal/composer-handle";
import type { PluginComposerApi } from "@get-bb/plugin-sdk";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { useComposer, useComposerView } from "@/lib/plugin-sdk-hooks";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { ComposerBannersSlot } from "./PluginComposerBanners";
import { resetAllCrashedPluginSlotsForTest } from "./PluginSlotMount";
import {
  PluginComposerViewProvider,
  PluginComposerHostProvider,
  type PluginComposerHost,
  usePluginComposerViewModel,
} from "./plugin-composer-host";

const SCOPE = { kind: "thread", threadId: "thr_host" } as const;

function ComposerHost({ text }: { text: string }) {
  const view = usePluginComposerViewModel({
    scope: SCOPE,
    layout: "expanded",
    text,
    attachmentCount: 0,
    isRunning: false,
    isSubmitting: false,
  });
  return (
    <PluginComposerViewProvider value={view}>
      <ComposerBannersSlot />
    </PluginComposerViewProvider>
  );
}

beforeEach(() => {
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
});

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
});

describe("composer host view context", () => {
  it("keeps draft-independent banners still while view readers follow each keystroke", () => {
    const staticRenders = vi.fn();
    const viewRenders = vi.fn();
    function StaticBanner() {
      staticRenders();
      return <div>static banner</div>;
    }
    function ViewBanner() {
      viewRenders();
      return <div data-testid="view-text">{useComposerView().draft.text}</div>;
    }
    setPluginSlotRegistrations(
      "example-plugin",
      makePluginRegistrationSet({
        composerCustomizations: [
          {
            id: "banners",
            banners: [
              { id: "static", component: StaticBanner },
              { id: "view", component: ViewBanner },
            ],
          },
        ],
      }),
    );

    const view = render(
      <MemoryRouter>
        <ComposerHost text="" />
      </MemoryRouter>,
    );
    const staticRendersBefore = staticRenders.mock.calls.length;
    const viewRendersBefore = viewRenders.mock.calls.length;
    for (const text of ["h", "he", "hel", "hell", "hello"]) {
      view.rerender(
        <MemoryRouter>
          <ComposerHost text={text} />
        </MemoryRouter>,
      );
    }

    expect(staticRenders).toHaveBeenCalledTimes(staticRendersBefore);
    expect(viewRenders).toHaveBeenCalledTimes(viewRendersBefore + 5);
    expect(screen.getByTestId("view-text").textContent).toBe("hello");
  });
});

it("releases mounted before-submit hooks on plugin reload, scope change and unmount", async () => {
  const beforeSubmit = createComposerBeforeSubmit();
  const draft = { text: "original", mentions: [], attachments: [] };
  let composer!: PluginComposerApi;
  const listener = vi.fn(() => ({ draft: { text: "transformed", mentions: [] } }));
  function Banner() {
    composer = useComposer();
    useEffect(() => {
      composer.experimental_onBeforeSubmit(listener);
    }, [composer]);
    return null;
  }
  const registrations = makePluginRegistrationSet({
    composerCustomizations: [{
      id: "before",
      scopes: ["new-thread"],
      banners: [{ id: "before", component: Banner }],
    }],
  });
  const host: PluginComposerHost = {
    scope: { kind: "new-thread", projectId: "proj_one" },
    textEffectKey: "before-submit-lifetime",
    getCurrent: () => draft,
    subscribeDraft: () => () => {},
    setDraft: () => {},
    focus: () => {},
    onBeforeSubmit: beforeSubmit.register,
  };
  function Surface({ value }: { value: PluginComposerHost }) {
    const view = usePluginComposerViewModel({
      scope: value.scope,
      layout: "expanded",
      text: draft.text,
      attachmentCount: 0,
      isRunning: false,
      isSubmitting: false,
    });
    return (
      <MemoryRouter>
        <PluginComposerHostProvider value={value}>
          <PluginComposerViewProvider value={view}>
            <ComposerBannersSlot />
          </PluginComposerViewProvider>
        </PluginComposerHostProvider>
      </MemoryRouter>
    );
  }
  setPluginSlotRegistrations("before-plugin", registrations);
  const surface = render(<Surface value={host} />);
  expect((await beforeSubmit.run(draft)).text).toBe("transformed");
  act(() => setPluginSlotRegistrations("before-plugin", makePluginRegistrationSet()));
  expect(await beforeSubmit.run(draft)).toEqual(draft);
  act(() => setPluginSlotRegistrations("before-plugin", registrations));
  expect((await beforeSubmit.run(draft)).text).toBe("transformed");
  const previousComposer = composer;
  const nextBeforeSubmit = createComposerBeforeSubmit();
  surface.rerender(<Surface value={{
    ...host,
    scope: { kind: "new-thread", projectId: "proj_two" },
    onBeforeSubmit: nextBeforeSubmit.register,
  }} />);
  expect(await beforeSubmit.run(draft)).toEqual(draft);
  expect(() => previousComposer.experimental_onBeforeSubmit(listener)).toThrow();
  const callsBefore = listener.mock.calls.length;
  expect((await nextBeforeSubmit.run(draft)).text).toBe("transformed");
  expect(listener).toHaveBeenCalledTimes(callsBefore + 1);
  surface.unmount();
  expect(await nextBeforeSubmit.run(draft)).toEqual(draft);
  expect(() => composer.experimental_onBeforeSubmit(listener)).toThrow();
});
