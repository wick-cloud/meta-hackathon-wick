import { types } from 'pg';
import { parseDatabaseNumeric } from '../src/server/db.js';

// Disposable fixture pools use the production pool's NUMERIC conversion.
types.setTypeParser(1700, parseDatabaseNumeric);
