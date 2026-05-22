/**
 * src/globals.d.ts
 * Global TypeScript type declarations.
 * This file tells TypeScript about custom properties on Window
 * (like YouTube's embedded data objects) so it stops complaining
 * about "Property 'ytInitialData' does not exist on type Window".
 *
 * WHAT IS A .d.ts FILE?
 * A declaration file — it only contains types, no runtime code.
 * TypeScript reads it automatically (no import needed).
 */
declare global {
  interface Window {
    ytInitialData:           any;
    ytInitialPlayerResponse: any;
    ytcfg:                   any;
    _sharedData:             any;
    chrome:                  any;
    XLSX:                    any;
  }
  interface Element {
    href:       string;
    src:        string;
    alt:        string;
    currentSrc: string;
    content:    string;
    value:      string;
    click():    void;
  }
}
export {};
