/* Quick checks for the Google Form name parsing.  Run: node tools/test-names.js */

const { formatPlayerName, extractPlayers, pickNameColumn, splitHeader, parseDelimited } =
  require('../public/names.js');

let pass = 0;
let fail = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`); }
}

console.log('\nformatPlayerName');
eq(formatPlayerName('Oliyad Tesfaye'), 'Oliyad T', 'first name + one letter of last');
eq(formatPlayerName('  mary   jane  watson '), 'Mary W', 'middle names ignored, spacing collapsed');
eq(formatPlayerName('Smith, John'), 'John S', '"Last, First" is flipped');
eq(formatPlayerName('AXON'), 'AXON', 'single name kept as typed');
eq(formatPlayerName('McArthur Wallace'), 'McArthur W', 'existing capitals preserved');
eq(formatPlayerName('oliyad'), 'Oliyad', 'lowercase single name is tidied');
eq(formatPlayerName("O'Brien Kelly"), "O'Brien K", 'apostrophes survive');
eq(formatPlayerName('Jean-Luc Picard'), 'Jean-Luc P', 'hyphenated first name kept whole');
eq(formatPlayerName('jean-luc picard'), 'Jean-Luc P', 'lowercase hyphenated name capitalised on both halves');
eq(formatPlayerName("o'brien kelly"), "O'Brien K", 'lowercase name with an apostrophe');
eq(formatPlayerName('José Álvarez'), 'José Á', 'accented initial');
eq(formatPlayerName('Ada Lovelace', { upper: true }), 'ADA L', 'uppercase option');
eq(formatPlayerName(''), '', 'blank in, blank out');
eq(formatPlayerName(null), '', 'null in, blank out');

console.log('\nGoogle Forms CSV export');
const gform = [
  'Timestamp,Email Address,What is your full name?,In-game name (IGN),Squad',
  '8/16/2026 9:03:11,a@x.com,Oliyad Tesfaye,SRX AXON,Alpha',
  '8/16/2026 9:04:52,b@x.com,"Watson, Mary Jane",MJW,Alpha',
  '8/16/2026 9:06:01,c@x.com,jean-luc picard,CAPT,Bravo',
].join('\n');

const rows = parseDelimited(gform);
eq(rows.length, 4, 'header + 3 responses parsed');
eq(rows[2][2], 'Watson, Mary Jane', 'quoted field with a comma stays one cell');

const { headers, body } = splitHeader(rows);
eq(headers.length, 5, 'header row detected');
eq(pickNameColumn(headers, body), 3, 'prefers the IGN column over "full name"');

eq(
  extractPlayers(gform, { nameCol: 2 }).players.map((p) => p.name),
  ['Oliyad T', 'Mary W', 'Jean-Luc P'],
  'full-name column formatted'
);

console.log('\nother shapes');
eq(
  extractPlayers('Oliyad Tesfaye\nMary Watson\nJohn Smith').players.map((p) => p.name),
  ['Oliyad T', 'Mary W', 'John S'],
  'plain pasted list with no header'
);
eq(
  extractPlayers('Name\tScore\nOliyad Tesfaye\t1200\nMary Watson\t950', { scoreCol: 1 }).players,
  [{ name: 'Oliyad T', score: 1200 }, { name: 'Mary W', score: 950 }],
  'tab-separated spreadsheet paste with scores'
);
eq(
  extractPlayers('Name\nOliyad Tesfaye\nOliyad Tekle\nOliyad Tesfaye').players.map((p) => p.name),
  ['Oliyad T'],
  'duplicates collapse — including two players who shorten the same way'
);
eq(
  extractPlayers('Name\nOliyad Tesfaye\nOliyad Tekle', { dedupe: false }).players.map((p) => p.name),
  ['Oliyad T', 'Oliyad T'],
  'dedupe can be turned off'
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
