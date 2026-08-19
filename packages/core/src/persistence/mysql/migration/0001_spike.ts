export const version = "0001_mysql_spike"

export const statements = [
  `CREATE TABLE IF NOT EXISTS oc_user_fence (
    user_id VARCHAR(128) PRIMARY KEY,
    generation BIGINT UNSIGNED NOT NULL,
    owner_instance_id VARCHAR(128) NOT NULL,
    updated_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS oc_project (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NULL,
    directory VARCHAR(2048) NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS oc_session (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(128) NOT NULL,
    generation BIGINT UNSIGNED NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    directory VARCHAR(2048) NOT NULL,
    title VARCHAR(512) NOT NULL,
    status VARCHAR(32) NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    INDEX oc_session_user_updated_id_idx (user_id, updated_at, id),
    CONSTRAINT oc_session_project_fk FOREIGN KEY (project_id) REFERENCES oc_project(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS oc_run (
    id VARCHAR(64) NOT NULL,
    user_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    generation BIGINT UNSIGNED NOT NULL,
    status VARCHAR(32) NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, id),
    INDEX oc_run_active_idx (user_id, session_id, generation, status),
    CONSTRAINT oc_run_session_fk FOREIGN KEY (session_id) REFERENCES oc_session(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS oc_event_sequence (
    user_id VARCHAR(128) NOT NULL,
    aggregate_id VARCHAR(64) NOT NULL,
    seq INT NOT NULL,
    PRIMARY KEY (user_id, aggregate_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS oc_event (
    id VARCHAR(64) NOT NULL,
    user_id VARCHAR(128) NOT NULL,
    aggregate_id VARCHAR(64) NOT NULL,
    seq INT UNSIGNED NOT NULL,
    type VARCHAR(128) NOT NULL,
    data JSON NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, id),
    UNIQUE KEY oc_event_aggregate_seq_idx (user_id, aggregate_id, seq),
    CONSTRAINT oc_event_sequence_fk FOREIGN KEY (user_id, aggregate_id)
      REFERENCES oc_event_sequence(user_id, aggregate_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS oc_session_input (
    id VARCHAR(64) NOT NULL,
    user_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    request_id VARCHAR(64) NOT NULL,
    prompt JSON NOT NULL,
    delivery VARCHAR(16) NOT NULL,
    admitted_seq INT UNSIGNED NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, id),
    UNIQUE KEY oc_session_input_request_idx (user_id, request_id),
    UNIQUE KEY oc_session_input_admitted_idx (user_id, session_id, admitted_seq),
    CONSTRAINT oc_session_input_session_fk FOREIGN KEY (session_id) REFERENCES oc_session(id) ON DELETE CASCADE,
    CONSTRAINT oc_session_input_run_fk FOREIGN KEY (user_id, run_id) REFERENCES oc_run(user_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS oc_request_dedup (
    user_id VARCHAR(128) NOT NULL,
    request_id VARCHAR(64) NOT NULL,
    operation VARCHAR(64) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    response JSON NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, request_id, operation)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
] as const
