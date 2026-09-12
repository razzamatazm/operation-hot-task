/* The loan suggestion list, shared by the create form's Folder Name typeahead
   and the Tasks board's loan search (#333).

   Lifted out of the form rather than copied into the search, so both draw the
   same options with the same classes and the same press handling. The input
   around each list is deliberately not shared: the form previews a highlighted
   name into its own field and forgets a picked loan on typing, and the search
   owns neither a field value nor a loan link, so each keeps its own box and its
   own keys and hands this list the matches and the highlight.

   A press picks on mousedown and cancels its default, so focus stays in the box
   and the pick is not lost to the box's blur. */
import type { Loan, LoanMatch } from "@loan-tasks/shared";

export const LoanSuggestionList = ({
  matches,
  highlight,
  optionId,
  id,
  className,
  onHighlight,
  onPick
}: {
  matches: LoanMatch[];
  highlight: number;
  /* The option's element id, which the box's `aria-activedescendant` names. */
  optionId: (index: number) => string;
  id?: string;
  className?: string;
  onHighlight: (index: number) => void;
  onPick: (loan: Loan) => void;
}) => (
  <ul id={id} className={className ? `loan-typeahead-list ${className}` : "loan-typeahead-list"} role="listbox">
    {matches.map((m, i) => (
      <li key={m.loan.id} role="presentation">
        <button
          type="button"
          id={optionId(i)}
          role="option"
          aria-selected={i === highlight}
          className={`loan-typeahead-option${i === highlight ? " loan-typeahead-option-active" : ""}`}
          onMouseEnter={() => onHighlight(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(m.loan);
          }}
        >
          <span className="loan-typeahead-name">{m.loan.name}</span>
          {m.loan.humperdinkLink && <span className="loan-typeahead-link" aria-hidden="true">↗</span>}
        </button>
      </li>
    ))}
  </ul>
);
