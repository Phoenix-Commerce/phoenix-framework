import 'reflect-metadata';
import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import { ApolloServer } from 'apollo-server-express';
import { connectToDatabase } from './config/database';
import { PluginLoader } from './plugins/plugin-loader';
import env from './config/config';
import logger from './config/logger';
import { initEnforcer, getEnforcer } from './rbac';
import { authenticate } from './middleware/auth';
import { parse, type OperationDefinitionNode, type FieldNode } from 'graphql';

async function startServer() {
  await connectToDatabase();
  await initEnforcer(); // Initialize Casbin

  const pluginLoader = new PluginLoader();
  pluginLoader.loadPlugins();

  const schema = await pluginLoader.createSchema();

  const server = new ApolloServer({
    schema,
    context: ({ req }: { req: Request }) => ({
      user: req.user, // User object from middleware
      enforcer: getEnforcer(), // Casbin enforcer instance
    }),
  });

  await server.start();

  const app: Application = express();

  app.use(express.json());

  // Middleware to conditionally authenticate user and set user context
  app.use('/graphql', (req: Request, res: Response, next: NextFunction) => {
    if (req.body && req.body.query) {
      try {
        const parsedQuery = parse(req.body.query);
        const operationDefinitions = parsedQuery.definitions.filter(
          def => def.kind === 'OperationDefinition'
        ) as OperationDefinitionNode[];

        operationDefinitions.forEach(def => {
          const operationType = def.operation;
          const firstSelection = def.selectionSet.selections[0];
          if (firstSelection.kind === 'Field') {
            const operationName = (firstSelection as FieldNode).name.value;

            logger.info(`operation: Type=${operationType}, Name=${operationName}`); // Detailed logging for each operation

            // Define the operations that should bypass authentication
            const bypassAuthOperations = [
              { type: 'mutation', name: 'register' },
              { type: 'mutation', name: 'login' },
            ];

            const shouldBypassAuth = bypassAuthOperations.some(
              op => op.type === operationType && op.name === operationName
            );

            if (shouldBypassAuth) {
              logger.info('Bypassing authentication for operation:', {
                query: req.body.query,
                variables: req.body.variables,
              });
              return next(); // Bypass authentication for this request
            }
          }
        });

        // If no operation bypasses authentication, apply authentication middleware
        authenticate(req, res, next);
      } catch (error) {
        logger.error('Error parsing GraphQL query:', { error, query: req.body.query });
        // Optionally, you can continue to authentication or handle the error differently
        authenticate(req, res, next);
      }
    } else {
      // If there is no query in the request body, continue with authentication
      authenticate(req, res, next);
    }
  });

  server.applyMiddleware({ app });

  const port = env.PORT;
  app.listen(port, () => {
    logger.info(`Server is running at http://localhost:${port}${server.graphqlPath}`, { context: 'server' });
  });
}

startServer();
