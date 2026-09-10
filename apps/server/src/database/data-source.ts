import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseOptions } from './database.config';

export default new DataSource(databaseOptions());

