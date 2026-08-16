/* Quick checks for the Google Form name parsing.  Run: node tools/test-names.js */

const { formatPlayerName, extractPlayers, pickNameColumn, splitHeader, parseDelimited,
        searchKey, matchesQuery, playersFromJson } = require('../public/names.js');

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

console.log('\nsearch — real tags from the Ethio roster');
eq(searchKey('ꜱʜᴀᴅᴏᴡツᴋɪʟʟ').includes('shadow'), true, 'small capitals fold to ascii');
eq(searchKey('DAN!『ツ』Tｅｄｄｙ').includes('teddy'), true, 'fullwidth letters fold to ascii');
eq(searchKey('➳ᴹᴿ᭄ደመላሽ༒FF•').includes('mr'), true, 'modifier letters fold to ascii');
eq(matchesQuery('ᴰᴿㅤTaiLungㅤ!', 'tailung'), true, 'decorated prefix ignored');
eq(matchesQuery('EVO.R4IDENX7', 'evo'), true, 'plain prefix match');
eq(matchesQuery('EVO.RAIDEN', 'evo raiden'), true, 'two words match across punctuation');
eq(matchesQuery('XTR.SWANKY', 'swanky'), true, 'match after a dot');
eq(matchesQuery('Ʀøx┊ᴏʙɪᴛᴏོ', 'obito'), true, 'small caps plus separators');
eq(matchesQuery('ኢትዮsami', 'sami'), true, 'latin inside an amharic tag');
eq(matchesQuery('ኢትዮsami', 'ኢትዮ'), true, 'amharic query matches too');
eq(matchesQuery('Bobby', 'zzz'), false, 'non-match is a non-match');
eq(matchesQuery('Bobby', ''), true, 'empty query matches everything');

console.log('\njson import');
eq(playersFromJson('{"players":[{"name":"Bino","score":629}]}').players,
   [{ id: undefined, name: 'Bino', team: '', score: 629, avatar: '', highlight: false, eliminated: false }],
   'board export shape');
eq(playersFromJson('[{"name":"Bobby","score":900}]').players.length, 1, 'bare array of objects');
eq(playersFromJson('["AYKT1","Bino"]').players.map((p) => p.name), ['AYKT1', 'Bino'], 'plain list of names');
eq(playersFromJson('[{"player":"Abdi","points":"1,500"}]').players[0],
   { id: undefined, name: 'Abdi', team: '', score: 1500, avatar: '', highlight: false, eliminated: false },
   'alternate keys and a formatted number');
eq(playersFromJson('{"players":[{"name":"  Kidus  ","score":600},{"name":""}]}').players.length, 1,
   'blank names dropped, whitespace trimmed');
try { playersFromJson('{"foo":1}'); eq('no throw', 'throw', 'rejects a file with no players'); }
catch { eq('throw', 'throw', 'rejects a file with no players'); }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
