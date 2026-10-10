"""
Converts a property export (.xlsx) into a lead CSV for `npm run import`.
  python3 scripts/xlsx-to-leads.py "Property Export.xlsx" leads.csv
Uses Phone 1 as phone and Phone 2 as phone2 (dialed only when Phone 1 is not answered).
"""
import csv
import sys

import openpyxl

NOTE = 'Provided their details and has spoken with us before.'

source, target = sys.argv[1], sys.argv[2]
sheet = openpyxl.load_workbook(source, data_only=True).active
assert sheet is not None, f'{source} has no sheets'
rows = list(sheet.iter_rows(values_only=True))
header = list(rows[0])


def cell(row, column):
    value = row[header.index(column)]
    return '' if value is None else str(value).strip()


written = 0
with open(target, 'w', newline='') as f:
    out = csv.writer(f)
    out.writerow(['phone', 'phone2', 'name', 'timezone', 'consent', 'notes'])
    for row in rows[1:]:
        if not cell(row, 'Phone 1'):
            continue
        first, last = cell(row, 'Owner 1 First Name'), cell(row, 'Owner 1 Last Name')
        # Trusts and LLCs have no first name; leave the name empty so the agent doesn't greet "Wells Family Trust".
        name = f'{first} {last}'.strip() if first else ''
        address = f"{cell(row, 'Address')}, {cell(row, 'City')}, {cell(row, 'State')} {cell(row, 'Zip')}"
        notes = f"Property: {address}. Owner on record: {f'{first} {last}'.strip()}. {NOTE}"
        out.writerow([cell(row, 'Phone 1'), cell(row, 'Phone 2'), name, 'America/Los_Angeles', 'yes', notes])
        written += 1

print(f'Wrote {written} leads to {target}')
