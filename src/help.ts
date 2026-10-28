const collectExample = "just collect_unkorrigiert LA_WiSe2627/Blatt1";
const splitExample = "just split_korrigiert LA_WiSe2627/Blatt1";
const declareExample = "just declare_points LA_WiSe2627/Blatt1";

export function shortHelp(): string {
  return `Examples:
  ${collectExample}
  ${splitExample}
  ${declareExample}
`;
}

export function commandHelp(): string {
  return `Merge Loesung PDFs from Course/BlattN/unkorrigiert into Course/BlattN/unkorrigiert_merged.pdf, then compress that file.
  ${collectExample}

Split Course/BlattN/korrigiert.pdf into Course/BlattN/korrigiert, one file per submission.
  ${splitExample}

Enter points for Course/BlattN in the browser.
  ${declareExample}
`;
}
