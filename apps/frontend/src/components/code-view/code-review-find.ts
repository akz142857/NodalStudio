import { closeSearchPanel, findNext, findPrevious, getSearchQuery, SearchQuery, setSearchQuery } from "@codemirror/search";
import { runScopeHandlers, type EditorView, type Panel } from "@codemirror/view";

const matchLimit = 1000;

export function createCodeFindPanel(view: EditorView): Panel {
  const document = view.dom.ownerDocument;
  const phrase = (key: string, ...values: Array<string | number>) => view.state.phrase(key, ...values);
  const dom = document.createElement("div");
  dom.className = "code-review-find";
  dom.setAttribute("role", "search");
  dom.setAttribute("aria-label", phrase("Find in file"));

  const field = document.createElement("input");
  field.type = "search";
  field.className = "code-review-find-field";
  field.placeholder = phrase("Find in file");
  field.setAttribute("aria-label", phrase("Find in file"));
  field.setAttribute("main-field", "true");
  field.spellcheck = false;

  function button(text: string, label: string, action: () => void) {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = text;
    control.title = phrase(label);
    control.setAttribute("aria-label", control.title);
    control.addEventListener("click", action);
    return control;
  }

  const options = document.createElement("div");
  options.className = "code-review-find-options";
  options.setAttribute("role", "group");
  options.setAttribute("aria-label", phrase("Search options"));
  let query = getSearchQuery(view.state);
  let matches: { from: number; to: number }[] = [];

  function updateQuery(changes: Partial<Pick<SearchQuery, "search" | "caseSensitive" | "wholeWord" | "regexp">>) {
    const next = new SearchQuery({ ...query, ...changes });
    if (!next.eq(query)) view.dispatch({ effects: setSearchQuery.of(next) });
  }

  const matchCase = button("Aa", "Match case", () => updateQuery({ caseSensitive: !query.caseSensitive }));
  const wholeWord = button("ab", "Match whole word", () => updateQuery({ wholeWord: !query.wholeWord }));
  wholeWord.className = "code-review-find-word";
  const regexp = button(".*", "Use regular expression", () => updateQuery({ regexp: !query.regexp }));
  options.append(matchCase, wholeWord, regexp);

  const status = document.createElement("span");
  status.className = "code-review-find-status";
  status.setAttribute("role", "status");
  const previous = button("↑", "Previous match", () => findPrevious(view));
  const next = button("↓", "Next match", () => findNext(view));
  const close = button("×", "Close find", () => closeSearchPanel(view));
  dom.append(field, options, status, previous, next, close);

  function showMatchCount() {
    const invalid = Boolean(query.search && !query.valid);
    const selected = view.state.selection.main;
    const current = matches.findIndex(({ from, to }) => from === selected.from && to === selected.to) + 1;
    const total = matches.length === matchLimit ? `${matchLimit - 1}+` : matches.length;
    const message = invalid ? phrase("Invalid regular expression")
      : !query.search ? ""
      : !total ? phrase("No matches")
      : current ? phrase("Match $1 of $2", current, total)
      : total === 1 ? phrase("1 match") : phrase("$ matches", total);
    if (status.textContent !== message) status.textContent = message;
    field.setAttribute("aria-invalid", String(invalid));
    previous.disabled = next.disabled = !matches.length;
  }

  function syncQuery() {
    if (field.value !== query.search) field.value = query.search;
    matchCase.setAttribute("aria-pressed", String(query.caseSensitive));
    wholeWord.setAttribute("aria-pressed", String(query.wholeWord));
    regexp.setAttribute("aria-pressed", String(query.regexp));
    matches = [];
    if (query.valid) {
      const cursor = query.getCursor(view.state);
      while (matches.length < matchLimit) {
        const match = cursor.next();
        if (match.done) break;
        matches.push(match.value);
      }
    }
    showMatchCount();
  }

  field.addEventListener("input", () => updateQuery({ search: field.value }));
  dom.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (runScopeHandlers(view, event, "search-panel")) {
      event.preventDefault();
    } else if (event.target === field && event.key === "Enter") {
      event.preventDefault();
      if (matches.length) (event.shiftKey ? findPrevious : findNext)(view);
    }
  });
  syncQuery();
  return {
    dom,
    top: true,
    mount: () => { field.focus({ preventScroll: true }); field.select(); },
    update: (update) => {
      const latest = getSearchQuery(update.state);
      if (update.docChanged || !latest.eq(query)) {
        query = latest;
        syncQuery();
      } else if (update.selectionSet) {
        showMatchCount();
      }
    },
  };
}
