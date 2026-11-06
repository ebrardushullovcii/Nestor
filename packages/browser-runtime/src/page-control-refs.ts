import type { Frame, Page, Locator } from "playwright";
import { randomUUID } from "node:crypto";

type Kind = "c" | "a" | "l" | "e";
interface Binding {
  frame: Frame;
  nodeRef: string;
  kind: Kind;
}
interface RefState {
  refs: Map<string, Binding>;
  identities: Map<string, string>;
}
const bindings = new WeakMap<Page, RefState>();
const groups = {
  c: "controls",
  a: "actions",
  l: "links",
  e: "clickables",
} as const;
interface Entry {
  index: number;
  ref?: string;
}

/** Capture the element identity in the same evaluation as its page facts. */
export function controlSnapshot(
  root: Page | Frame,
  locator: Locator,
  selectorsByKind: Partial<Record<Kind, string>>,
) {
  const page = "page" in root ? root.page() : root;
  return {
    async evaluateAll<R, Arg>(
      read: (elements: Element[], arg: Arg) => R,
      arg: Arg,
    ): Promise<R> {
      if (!page.context?.()?.newCDPSession)
        return locator.evaluateAll(
          read as Parameters<Locator["evaluateAll"]>[0],
          arg,
        ) as Promise<R>;
      const frame = "page" in root ? root : root.mainFrame();
      // Both the reader and this wrapper are self-contained browser scripts.
      const source = `(elements,arg)=>{
        const key=Symbol.for('nestor.controlRefs.v1');
        const state=globalThis[key]??={ids:new WeakMap(),roots:new WeakSet(),prefix:${JSON.stringify(`n${randomUUID()}`)},next:0};
        const identify=element=>{
          let ref=state.ids.get(element);
          if(!ref){ref=state.prefix+'-'+state.next++;state.ids.set(element,ref)}
          if(element.getAttribute('data-nestor-control-ref')!==ref)element.setAttribute('data-nestor-control-ref',ref);
          const root=element.getRootNode();
          if(!state.roots.has(root)){
            state.roots.add(root);
            new MutationObserver(records=>{
              for(const record of records)for(const added of record.addedNodes){
                if(!(added instanceof Element))continue;
                const nodes=[added];
                for(const node of nodes){
                  if(node.hasAttribute('data-nestor-control-ref')&&node.getAttribute('data-nestor-control-ref')!==state.ids.get(node))node.removeAttribute('data-nestor-control-ref');
                  nodes.push(...node.children,...(node.shadowRoot?.children??[]));
                }
              }
            }).observe(root,{childList:true,subtree:true});
          }
          return ref;
        };
        const result=(${read.toString()})(elements,arg);
        for(const [kind,selector] of Object.entries(${JSON.stringify(selectorsByKind)})){
          const matched=elements.filter(element=>element.matches(selector));
          const entries=Array.isArray(result)?result:result[${JSON.stringify(groups)}[kind]];
          for(const entry of entries){
            const element=matched[entry.index];
            if(element){
              entry.ref=(entry.ref??kind+entry.index)+':'+identify(element);
              const scope=element.form??element.closest('form,[role="form"],[role="dialog"],dialog');
              if(scope)entry.scopeKey='scope:'+identify(scope);
              if(kind==='c'){
                const rect=element.getBoundingClientRect();
                let ariaHidden=false,cssHidden=false;
                for(let node=element;node;node=node.parentElement??node.getRootNode().host){
                  const style=getComputedStyle(node);
                  ariaHidden ||= node.getAttribute('aria-hidden')==='true';
                  cssHidden ||= style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0';
                }
                entry.visibility={x:rect.x,y:rect.y,width:rect.width,height:rect.height,
                  viewportWidth:innerWidth,viewportHeight:innerHeight,
                  inViewport:rect.width>0&&rect.height>0&&rect.right>0&&rect.bottom>0&&rect.left<innerWidth&&rect.top<innerHeight,
                  offCanvas:rect.right<=0||rect.bottom<=0||rect.left+scrollX>=Math.max(innerWidth,document.documentElement.scrollWidth)||rect.top+scrollY>=Math.max(innerHeight,document.documentElement.scrollHeight),
                  zeroSize:rect.width===0||rect.height===0,ariaHidden,cssHidden};
              }
            }
          }
        }
        return result;
      }`;
      // This source contains only our self-contained DOM reader and fixed
      // selector strings, never page content or model-provided JavaScript.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const compile = new Function(`return ${source}`) as () => (
        elements: Element[],
        arg: Arg,
      ) => R;
      const result = (await locator.evaluateAll(
        compile() as Parameters<Locator["evaluateAll"]>[0],
        arg,
      )) as R;
      const state: RefState = bindings.get(page) ?? {
        refs: new Map(),
        identities: new Map(),
      };
      bindings.set(page, state);
      for (const kind of Object.keys(selectorsByKind) as Kind[]) {
        const entries = (
          Array.isArray(result)
            ? result
            : (result as Record<string, unknown>)[groups[kind]]
        ) as Entry[];
        for (const entry of entries) {
          const [ordinal, nodeRef] = entry.ref?.split(":") ?? [];
          if (!ordinal || !nodeRef) continue;
          const identity = `${nodeRef}:${kind}`;
          const handle =
            state.identities.get(identity) ??
            (state.refs.has(ordinal) ? `${nodeRef}${kind}` : ordinal);
          entry.ref = handle;
          state.refs.set(handle, { frame, nodeRef, kind });
          state.identities.set(identity, handle);
        }
      }
      return result;
    },
  };
}

export function boundControlLocator(
  page: Page,
  ref: string,
  kind: Kind,
): Locator | null {
  const binding = bindings.get(page)?.refs.get(ref);
  return binding && !binding.frame.isDetached() && binding.kind === kind
    ? binding.frame.locator(`[data-nestor-control-ref="${binding.nodeRef}"]`)
    : null;
}
export function controlRefFrame(
  page: Page,
  ref: string | undefined,
): Frame | undefined {
  return ref ? bindings.get(page)?.refs.get(ref)?.frame : undefined;
}
export function hasBoundControlRefs(page: Page): boolean {
  return bindings.has(page);
}
