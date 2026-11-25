// Keeps typography, radii and colors on the design-system tokens in tokens.css.
/** @type {import("stylelint").Config} */
export default {
  rules: {
    "color-no-hex": true,
    "declaration-property-value-disallowed-list": {
      // Literal sizes only; var() fallbacks, em-relative and fluid clamp() sizes are fine.
      "font-size": [/^\d*\.?\d+(px|rem)$/],
      font: [/^(\d00 )?\d*\.?\d+(px|rem)\b/],
      "border-radius": [/\d+px/],
    },
  },
  overrides: [
    {
      files: ["src/design-system/tokens.css"],
      rules: { "color-no-hex": null, "declaration-property-value-disallowed-list": null },
    },
  ],
};
