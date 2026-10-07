#!/usr/bin/env python3
"""Validate the complete contract against a fresh local database. Not run automatically."""
import json
import os
import urllib.request
import urllib.error

BASE = os.environ.get('API_URL', 'http://127.0.0.1:3001')
PASSWORD = 'Workspace123!'
ADMIN_EMAIL = 'admin@example.com'
BOND_EMAIL = 'jamesbond@example.com'

def call(path, body=None, token=None, expected=200, method=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    request = urllib.request.Request(BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers, method=method)
    try:
        with urllib.request.urlopen(request) as response:
            status, result = response.status, json.load(response)
    except urllib.error.HTTPError as error:
        status, result = error.code, json.load(error)
    assert status == expected, (path, status, result)
    return result

def login(email):
    challenge = call('/auth/login', {'email': email, 'password': PASSWORD})
    assert 'token' not in challenge and 'access_token' not in challenge
    assert challenge['expires_in'] == 300
    challenge_id = challenge['login_challenge_id']
    email_log = call('/dev/email-logs/latest?login_challenge_id=' + challenge_id)
    assert email_log['email'] == email
    assert email_log['expires_at'] - email_log['sent_at'] == 300
    body = {'login_challenge_id': challenge_id, 'code': email_log['code']}
    call('/auth/verify-2fa', {**body, 'code': 'invalid'}, expected=401)
    verified = call('/auth/verify-2fa', body)
    assert verified['access_token'] == verified['token']
    call('/auth/verify-2fa', body, expected=401)
    return verified['access_token']

seeded = call('/seed/users', {})['users']
assert len(seeded) == 2
assert {user['email'] for user in seeded} == {ADMIN_EMAIL, BOND_EMAIL}
assert len(call('/seed/users', {})['users']) == 2
bond = next(user for user in seeded if user['email'] == BOND_EMAIL)
admin_token = login(ADMIN_EMAIL)
assert call('/tasks', token=admin_token)['tasks'] == [], 'Use a fresh database. Existing task data is preserved.'
assert len(call('/users', token=admin_token)['users']) == 2
for user in seeded:
    assert {'id', 'full_name', 'email', 'role', 'created_at', 'updated_at'} <= user.keys()
    assert 'hashed_password' not in user and 'password_hash' not in user
items = [
    ('Prepare the project brief', 'Outline our goals, deliverables, and milestones.', 'high', '2026-10-12'),
    ('Review the onboarding flow', 'Walk through the first-time experience.', 'medium', '2026-10-14'),
    ('Organize the design assets', 'Bring the latest brand assets into one shared place.', 'low', '2026-10-16'),
    ('Finalize the launch checklist', 'Prepare every detail for launch day.', 'high', '2026-10-19'),
    ('Plan the team kickoff', 'Set the agenda and align the team.', 'medium', '2026-10-21'),
]
ids = [call('/tasks', {'title': title, 'description': description, 'priority': priority, 'due_date': date}, admin_token)['id']
       for title, description, priority, date in items]
assert len(call('/tasks', token=admin_token)['tasks']) == 5
# Verify assignment invalidates an already-primed staff cache.
bond_token = login(BOND_EMAIL)
assert call('/tasks/view-my-tasks', token=bond_token)['tasks'] == []
assert call('/tasks/view-my-tasks', token=bond_token)['cache']['hit'] is True
call('/tasks/assign', {'task_ids': ids[:3], 'user_id': bond['id']}, admin_token)
bond_token = login(BOND_EMAIL)
blocked = call('/tasks', {'title': 'Staff cannot create this', 'priority': 'medium'}, bond_token, expected=403)
assert blocked['message'] == 'The task creation rights are reserved for admins'
call('/tasks/assign', {'task_ids': ids[3:], 'user_id': bond['id']}, bond_token, expected=403)
call('/tasks', token=bond_token, expected=403)
call('/users', token=bond_token, expected=403)
call('/tasks/view-my-tasks', expected=401)
first = call('/tasks/view-my-tasks', token=bond_token)
assert first['user']['email'] == BOND_EMAIL and first['user']['role'] == 'staff'
assert first['summary'] == {'total_assigned_tasks': 3}
assert first['cache']['hit'] is False
assert {task['id'] for task in first['tasks']} == set(ids[:3])
assert {task['priority'] for task in first['tasks']} == {'high', 'medium', 'low'}
for task in first['tasks']:
    assert task['status'] == 'todo'
    assert task['assigned_to'] == BOND_EMAIL and task['assigned_to_id'] == bond['id']
    assert {'created_by_id', 'created_at', 'updated_at', 'description'} <= task.keys()
second = call('/tasks/view-my-tasks', token=bond_token)
assert second['cache']['hit'] is True and second['tasks'] == first['tasks']
print('Final James Bond response (first database read):')
print(json.dumps(first, indent=2))
print('PASS: exactly five tasks; three assignments; database response and summary; five-minute 2FA; single-use codes; staff 403; cache miss then hit.')
