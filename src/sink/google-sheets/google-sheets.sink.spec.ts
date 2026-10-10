import { rowFor } from './google-sheets.sink';

const header = ['Status', 'Meeting Time', 'Name', 'Phone', 'Phone 2', 'Address', 'ZIP Code', 'Notes', 'Not-Interested Reason', 'Attempts', 'Last Call', 'Call Summary', 'Recording', 'Lead ID'];
const leadRow = (id: string) => ['BOOKED', '', '', '+14155550100', '', '', '', '', '', '1', '', '', '', id];

describe('rowFor', () => {
  it('finds the row that already holds the lead, even after the sheet was sorted', () => {
    expect(rowFor([header, leadRow('b'), leadRow('a')], 'a')).toBe(3);
  });

  it('puts a new lead after everything, including notes typed in other columns', () => {
    const note = ['', '', 'Technician Chimney', '10:00 - 12:00', 'Sunday'];
    expect(rowFor([header, leadRow('a'), [], note], 'new')).toBe(5);
  });

  it('starts on row 2 in an empty sheet, and never matches the header', () => {
    expect(rowFor([], 'x')).toBe(2);
    expect(rowFor([header], 'Lead ID')).toBe(2);
  });
});
