-- A single D1 row serializes beta registration admission. Operators can stop
-- new registrations immediately without redeploying the Worker.
CREATE TABLE beta_controls (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  registration_enabled INTEGER NOT NULL CHECK (registration_enabled IN (0, 1)),
  max_laptops INTEGER NOT NULL CHECK (max_laptops BETWEEN 1 AND 100000)
);
INSERT INTO beta_controls(id, registration_enabled, max_laptops) VALUES (1, 1, 50);
ALTER TABLE email_challenges ADD COLUMN purpose TEXT NOT NULL DEFAULT 'sign_in'
  CHECK (purpose IN ('sign_in', 'deletion'));
