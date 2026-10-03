#!/usr/bin/env python3
"""Convert the research lane's resources/resources.json into the app's data/resources.json.

Source of truth stays ../../resources/resources.json (the research lane's file).
Re-run after every research update:  python3 tools/import_resources.py

Mapping rules:
- verification_status 'אומת' and 'אומת (צילום ארכיון)' -> verified=true (both were read from a page
  with a URL that supports the facts; the archive one is labelled in the UI with its snapshot date).
- 'מקור ישן' and 'לא אומת' -> verified=false (still shown, labelled, ranked last).
- 'לא להפנות' -> do_not_refer=true. The app never offers it as a match, it only lists it on "עוד".
- category[] = app category ids derived from the research category + the needs[] tags.
  primary[] = the ids from the research category alone (ranked first in matching).
"""
import json, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parent.parent / 'resources' / 'resources.json'
DST = HERE.parent / 'data' / 'resources.json'

APP_CATS = ['shelter', 'food', 'clothes', 'health', 'mental', 'addiction', 'documents',
            'benefits', 'debts', 'legal', 'work', 'family', 'other']

# research category -> app categories
BASE = {
    'shelter': ['shelter'], 'housing': ['shelter'], 'municipal_welfare': ['shelter', 'benefits'],
    'food': ['food'], 'hygiene_clothing': ['clothes'], 'health': ['health'], 'equipment': ['health'],
    'mental_health': ['mental'], 'addiction': ['addiction'], 'benefits': ['benefits'],
    'debt_finance': ['debts'], 'legal': ['legal'], 'employment': ['work'],
    'women_safety': ['family'], 'migrants': ['legal'], 'youth': ['shelter'],
    'released_prisoners': ['work', 'benefits'], 'gov_hotlines': ['other'], 'info': ['other'],
    'connectivity': ['other'],
}

# needs[] tag substrings -> app category (first matching rules win per tag; a tag may hit several)
NEED_RULES = [
    ('מיצוי זכויות', 'benefits'),
    ('מחסה', 'shelter'), ('לינה', 'shelter'), ('דיור', 'shelter'), ('הוסטל', 'shelter'),
    ('דירה', 'shelter'), ('דירת', 'shelter'), ('יציאה מהרחוב', 'shelter'), ('צעירים חסרי בית', 'shelter'),
    ('מזון', 'food'), ('ארוח', 'food'),
    ('ביגוד', 'clothes'), ('מקלחת', 'clothes'), ('כביסה', 'clothes'), ('לוקר', 'clothes'),
    ('רופא', 'health'), ('בריאות', 'health'), ('אבחון', 'health'), ('רפואי', 'health'),
    ('בדיקות', 'health'), ('כיסא גלגלים', 'health'), ('הליכון', 'health'), ('בית חולים', 'health'),
    ('צמצום נזקים', 'health'),
    ('תמיכה רגשית', 'mental'), ('נפש', 'mental'), ('טראומה', 'mental'), ('חרדה', 'mental'),
    ('בדידות', 'mental'), ('פסיכולוגי', 'mental'), ('משבר', 'mental'),
    ('גמילה', 'addiction'), ('התמכרו', 'addiction'), ('אלכוהול', 'addiction'), ('הימורים', 'addiction'),
    ('סמים', 'addiction'), ('ניקיון מסמים', 'addiction'),
    ('תעודות', 'documents'), ('טפסים', 'documents'), ('מכתבים', 'documents'), ('מעמד', 'documents'),
    ('ביטוח לאומי', 'benefits'), ('קצבה', 'benefits'), ('נכות', 'benefits'), ('הכנסה', 'benefits'),
    ('דמי קיום', 'benefits'), ('ועדה רפואית', 'benefits'), ('שכר דירה', 'benefits'),
    ('הוצאה לפועל', 'debts'), ('חובות', 'debts'), ('חדלות פירעון', 'debts'), ('תקציב', 'debts'),
    ('ליווי כלכלי', 'debts'), ('מצוקה כלכלית', 'debts'),
    ('משפטי', 'legal'), ('הליך פלילי', 'legal'), ('אפליה', 'legal'), ('תביעות', 'legal'),
    ('פקחים', 'legal'), ('החרמת ציוד', 'legal'), ('זכויות אדם', 'legal'), ('זכויות ברחוב', 'legal'),
    ('פגיעה בזכויות', 'legal'), ('זכויות עובדים', 'legal'), ('זכויות בעבודה', 'legal'), ('דיני עבודה', 'legal'),
    ('יחסי עבודה', 'legal'), ('אשפוז כפוי', 'legal'), ('פליטים', 'legal'), ('מבקשי מקלט', 'legal'),
    ('תעסוקה', 'work'), ('עבודה', 'work'), ('הכשרה', 'work'), ('קורות חיים', 'work'),
    ('השלמת השכלה', 'work'),
    ('משפחה', 'family'), ('משפחות', 'family'),
    ('טלפון', 'other'), ('סלולר', 'other'),
]

# The "where to start" path in resources/RESOURCES.md (section "אדם ברחוב ליד הבימה — מאיפה מתחילים").
START_HERE = {'tlv-homeless-unit', 'lasova-gagon', 'tlv-saleet', 'lasova-restaurant', 'tlv-106', 'molsa-118',
              'eran', 'sahar', 'moj-legal-aid', 'tlv-shil', 'tlv-rights-centers'}

VERIFIED = {'אומת', 'אומת (צילום ארכיון)'}
ARCHIVE_RE = re.compile(r'https://web\.archive\.org/web/\S+')


def need_cats(tag):
    return [cat for sub, cat in NEED_RULES if sub in tag]


def primary_source(sources, status=''):
    # A row verified from an archive snapshot cites that snapshot (e.g. a phone that is in the
    # snapshot but not on the live page), so the app can link to it.
    if status == 'אומת (צילום ארכיון)':
        wb = [s for s in sources if s.get('kind') == 'wayback']
        if wb:
            return wb[0]
    direct = [s for s in sources if s.get('kind') == 'direct']
    return (direct or sources)[0] if sources else None


def convert(e):
    status = e['verification_status']
    primary = BASE.get(e['category'], ['other'])
    cats = list(primary)
    for tag in e.get('needs', []):
        for c in need_cats(tag):
            if c not in cats:
                cats.append(c)
    src = primary_source(e.get('sources', []), status)
    archive = None
    if src and src.get('kind') == 'wayback':
        m = ARCHIVE_RE.search(src.get('note', ''))
        archive = m.group(0) if m else f"https://web.archive.org/web/{(src.get('snapshot') or '').replace('-', '')}/{src['url']}"
    c = e.get('contact', {})
    out = {
        'id': e['id'],
        'name_he': e['name_he'],
        'category': [x for x in APP_CATS if x in cats],
        'primary': primary,
        'offers_he': e.get('offers', ''),
        'eligibility_he': e.get('eligibility', ''),
        'contact': {k: v for k, v in {
            'phone': c.get('phone', ''), 'url': c.get('website', ''), 'address': c.get('address', ''),
            'hours': c.get('hours', ''),
        }.items() if v},
        'area': e.get('area', ''),
        'source_url': src['url'] if src else '',
        'source_kind': src.get('kind', '') if src else '',
        'verified': status in VERIFIED,
        'verification_status': status,
        'verified_date': e.get('verified_date', ''),
        'category_he': e.get('category_he', ''),
        'needs_he': e.get('needs', []),
        'notes_he': e.get('notes', ''),
        'sources': e.get('sources', []),
    }
    if archive:
        out['archive_url'] = archive
        out['snapshot'] = src.get('snapshot', '')
    if e['id'] in START_HERE:
        out['start_here'] = True
    if status == 'לא להפנות':
        out['do_not_refer'] = True
    return out


def main():
    src = json.loads(SRC.read_text(encoding='utf-8'))
    rows = [convert(e) for e in src]
    missing = START_HERE - {r['id'] for r in rows}
    if missing:
        sys.exit(f'START_HERE ids not in source: {missing}')
    bad = [r['id'] for r in rows if r['verified'] and not re.match(r'^https?://', r['source_url'])]
    if bad:
        sys.exit(f'verified rows without source_url: {bad}')
    doc = {
        'schema': 'resources.schema.json',
        'schema_version': 1,
        'sample': False,
        'note_he': 'מקורות עזרה אמיתיים מתוך resources/resources.json (מחקר 03.10.2026). לכל רשומה יש קישור למקור ומצב אימות. '
                   '"אומת" = נקרא היום באתר הרשמי · "אומת (צילום ארכיון)" = נקרא מצילום Wayback בתאריך שמצוין · '
                   '"מקור ישן" / "לא אומת" = לבדוק לפני הפניה. פרטים משתנים: לוודא בטלפון לפני שמפנים אדם.',
        'updated': max((r['verified_date'] for r in rows if r['verified_date']), default=''),
        'generated_from': 'resources/resources.json',
        'resources': rows,
    }
    DST.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    from collections import Counter
    print(f'{len(rows)} rows -> {DST}')
    print('verified:', sum(r['verified'] for r in rows), '| do_not_refer:', sum(bool(r.get('do_not_refer')) for r in rows))
    print('per app category:', dict(Counter(c for r in rows if not r.get('do_not_refer') for c in r['category'])))


if __name__ == '__main__':
    main()
