-- Mailboxes: 3 for alice (user 1), 1 for bob (user 2)
INSERT INTO mailboxes (user_id, email, daily_limit, hourly_limit) VALUES
  (1, 'alice-work@test.com',     50,  5),
  (1, 'alice-personal@test.com', 100, 10),
  (1, 'alice-sales@test.com',    200, 20),
  (2, 'bob@test.com',            100, 10);

-- Sequences: 2 for alice, 0 for bob
INSERT INTO sequences (user_id, name, status) VALUES
  (1, 'Onboarding',    'active'),
  (1, 'Re-engagement', 'draft');

-- Steps for sequence 1 (id=1)
INSERT INTO sequence_steps (sequence_id, step_order, delay_days, subject, body) VALUES
  (1, 1, 0, 'Welcome to our product!',
   'Hi {{name}},\n\nWelcome aboard! We''re thrilled to have you.\n\nBest,\nAlice'),
  (1, 2, 3, 'How are things going?',
   'Hi {{name}},\n\nJust checking in to see how you''re getting on.\n\nBest,\nAlice'),
  (1, 3, 7, 'One last thing...',
   'Hi {{name}},\n\nWanted to share one more tip before we wrap up.\n\nBest,\nAlice');

-- Steps for sequence 2 (id=2)
INSERT INTO sequence_steps (sequence_id, step_order, delay_days, subject, body) VALUES
  (2, 1, 0, 'We miss you!',
   'Hi {{name}},\n\nIt''s been a while — come back and see what''s new.\n\nBest,\nAlice'),
  (2, 2, 5, 'A special offer just for you',
   'Hi {{name}},\n\nHere''s something special to welcome you back.\n\nBest,\nAlice');

-- Prospects for sequence 1
INSERT INTO prospects (sequence_id, email, name, status) VALUES
  (1, 'prospect1@example.com', 'John Smith',  'active'),
  (1, 'prospect2@example.com', 'Jane Doe',    'active'),
  (1, 'prospect3@example.com', 'Bob Johnson', 'unsubscribed');

-- Pre-schedule step 1 for active prospects so the worker fires immediately
INSERT INTO scheduled_emails (sequence_id, step_id, prospect_id, mailbox_id, scheduled_at, status) VALUES
  (1, 1, 1, 1, NOW(), 'pending'),
  (1, 1, 2, 1, NOW(), 'pending');
