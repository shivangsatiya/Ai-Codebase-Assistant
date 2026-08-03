import { UserModel, type UserDocument } from '../models/user.model';

export interface CreateUserInput {
  email: string;
  passwordHash: string;
}

/**
 * Why an interface here instead of just calling UserModel directly from
 * the service?
 *
 * Two reasons, both about isolating change:
 *
 * 1. Testability: AuthService can be unit-tested against a fake
 *    IUserRepository (a plain in-memory object) with zero database
 *    involved — no mongodb-memory-server, no async setup/teardown, tests
 *    run in milliseconds.
 * 2. Swappability: if this project ever moved off Mongoose (different
 *    driver, different database entirely), only this one file changes.
 *    Every service that depends on IUserRepository is untouched.
 *
 * This is the Repository Pattern + Dependency Inversion in practice, not
 * just as a buzzword for the resume.
 */
export interface IUserRepository {
  findByEmail(email: string): Promise<UserDocument | null>;
  findById(id: string): Promise<UserDocument | null>;
  create(input: CreateUserInput): Promise<UserDocument>;
}

export class MongoUserRepository implements IUserRepository {
  async findByEmail(email: string): Promise<UserDocument | null> {
    return UserModel.findOne({ email: email.toLowerCase().trim() }).exec();
  }

  async findById(id: string): Promise<UserDocument | null> {
    return UserModel.findById(id).exec();
  }

  async create(input: CreateUserInput): Promise<UserDocument> {
    return UserModel.create({
      email: input.email.toLowerCase().trim(),
      passwordHash: input.passwordHash,
    });
  }
}
