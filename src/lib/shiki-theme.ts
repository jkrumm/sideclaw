import type { ThemeRegistration } from "shiki";

// Blueprint v6 dark palette — sourced from blueprint-design-tokens.css.
// Ported from basalt-ui-playground's build-time MDX theme so sideclaw's
// runtime markdown preview matches the same syntax-highlight identity.
export const blueprintDarkTheme: ThemeRegistration = {
  name: "blueprint-dark",
  type: "dark",
  colors: {
    "editor.background": "#252a31", // dark-gray-2 — matches CodeMirror editor bg
    "editor.foreground": "#c5cbd3",
    "editor.lineHighlightBackground": "#2f343c",
    "editorLineNumber.foreground": "#5f6b7c",
    "editorLineNumber.activeForeground": "#8f99a8",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#5f6b7c", fontStyle: "italic" },
    },
    {
      scope: ["keyword", "keyword.control", "keyword.operator", "storage.type", "storage.modifier"],
      settings: { foreground: "#8abbff" }, // blue-5
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "entity.other.inherited-class",
        "support.class",
      ],
      settings: { foreground: "#68c1ee" }, // cerulean-5
    },
    {
      scope: ["string", "string.quoted", "string.template", "string.regexp"],
      settings: { foreground: "#72ca9b" }, // green-5
    },
    {
      scope: ["constant.numeric", "constant.language", "constant.character", "constant.other"],
      settings: { foreground: "#fbb360" }, // orange-5
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call.generic"],
      settings: { foreground: "#7ae1d8" }, // turquoise-5
    },
    {
      scope: ["entity.other.attribute-name", "meta.decorator", "punctuation.decorator"],
      settings: { foreground: "#fbd065" }, // gold-5
    },
    {
      scope: ["support.type.builtin", "support.other.variable", "variable.language"],
      settings: { foreground: "#d69fd6" }, // violet-5
    },
    {
      scope: ["invalid", "invalid.illegal"],
      settings: { foreground: "#fa999c" }, // red-5
    },
    {
      scope: ["variable", "variable.parameter", "variable.other"],
      settings: { foreground: "#c5cbd3" }, // gray-5
    },
    {
      scope: ["punctuation", "meta.brace"],
      settings: { foreground: "#8f99a8" }, // gray-4
    },
    {
      scope: ["tag.html", "entity.name.tag"],
      settings: { foreground: "#8abbff" }, // blue-5
    },
    {
      scope: ["meta.tag.attributes", "entity.other.attribute-name.html"],
      settings: { foreground: "#68c1ee" }, // cerulean-5
    },
    {
      scope: ["markup.inserted"],
      settings: { foreground: "#72ca9b", fontStyle: "bold" },
    },
    {
      scope: ["markup.deleted"],
      settings: { foreground: "#fa999c", fontStyle: "bold" },
    },
  ],
};

/** Bundled Shiki light theme used when the app is in light mode. */
export const LIGHT_THEME = "github-light";
