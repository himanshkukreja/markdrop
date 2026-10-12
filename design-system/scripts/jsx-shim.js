const R = window.React;
function jsx(type, props, key) { const { children, ...rest } = props || {}; if (key !== undefined) rest.key = key; return children === undefined ? R.createElement(type, rest) : Array.isArray(children) ? R.createElement(type, rest, ...children) : R.createElement(type, rest, children); }
export { jsx, jsx as jsxs, jsx as jsxDEV }; export const Fragment = R.Fragment;
