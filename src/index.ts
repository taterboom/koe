import configProducts from '../config/products.json';
import { createHandler } from './app';
import type { ProductMap } from './products';

export default createHandler(configProducts as ProductMap) satisfies ExportedHandler<Env>;
