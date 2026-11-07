import { describe, it, expect } from 'vitest';
import { JavaSealedCompilerHost } from '../../../src/sajimora/languages/java/programs/JavaSealedCompilerHost';
import { JavaWireModelEngine } from '../../../src/sajimora/cross-language/JavaWireModelEngine';
import { ObjectWireType, UnionWireType } from '../../../src/sajimora/cross-language/CanonicalContractIR';

describe('Jackson polymorphism & creator mode resolution', () => {
  it('synthesizes "type": LITERAL("admin") discriminator property on AdminDto via @JsonTypeInfo + @JsonSubTypes', () => {
    const source = `
      package demo;

      @JsonTypeInfo(use = Id.NAME, include = As.PROPERTY, property = "type")
      @JsonSubTypes({
          @Type(value = AdminDto.class, name = "admin"),
          @Type(value = MemberDto.class, name = "member")
      })
      public interface UserDto {
      }

      public class AdminDto implements UserDto {
          private String name;
          public String getName() { return name; }
      }

      public class MemberDto implements UserDto {
          private int points;
          public int getPoints() { return points; }
      }
    `;

    const host = new JavaSealedCompilerHost({
      trackedFiles: ['demo/User.java'],
      readTextFile: () => source,
    });
    const engine = new JavaWireModelEngine(host);

    const adminResult = engine.extractWireType('demo.AdminDto');
    expect(adminResult.blockers).toEqual([]);
    expect(adminResult.wireType.kind).toBe('OBJECT');

    const adminObj = adminResult.wireType as ObjectWireType;
    const typeProp = adminObj.properties.find(p => p.wireName === 'type');
    expect(typeProp).toBeDefined();
    expect(typeProp).toMatchObject({
      wireName: 'type',
      type: {
        kind: 'LITERAL',
        value: 'admin',
      },
      optional: false,
      nullable: false,
      validationConstraints: [],
    });

    const nameProp = adminObj.properties.find(p => p.wireName === 'name');
    expect(nameProp).toBeDefined();
    expect(nameProp).toMatchObject({
      wireName: 'name',
      type: {
        kind: 'PRIMITIVE',
        scalar: 'string',
      },
    });

    // Parent interface returns UNION of subtypes
    const userResult = engine.extractWireType('demo.UserDto');
    expect(userResult.blockers).toEqual([]);
    expect(userResult.wireType.kind).toBe('UNION');
    const unionType = userResult.wireType as UnionWireType;
    expect(unionType.types).toHaveLength(2);
    expect(unionType.types[0].kind).toBe('OBJECT');
    expect(unionType.types[1].kind).toBe('OBJECT');
  });

  it('defaults discriminator property name to "@type" when omitted', () => {
    const source = `
      package demo;

      @JsonTypeInfo(use = Id.NAME)
      @JsonSubTypes({
          @Type(value = CatDto.class, name = "cat")
      })
      public interface AnimalDto {
      }

      public class CatDto implements AnimalDto {
          public boolean purrs;
      }
    `;

    const host = new JavaSealedCompilerHost({
      trackedFiles: ['demo/Animal.java'],
      readTextFile: () => source,
    });
    const engine = new JavaWireModelEngine(host);

    const catResult = engine.extractWireType('demo.CatDto');
    expect(catResult.blockers).toEqual([]);
    expect(catResult.wireType.kind).toBe('OBJECT');
    const catObj = catResult.wireType as ObjectWireType;
    const typeProp = catObj.properties.find(p => p.wireName === '@type');
    expect(typeProp).toBeDefined();
    expect(typeProp).toMatchObject({
      wireName: '@type',
      type: {
        kind: 'LITERAL',
        value: 'cat',
      },
      optional: false,
      nullable: false,
    });
  });

  it('emits UNRESOLVED_JACKSON_DEDUCTION when use = Id.DEDUCTION is specified', () => {
    const source = `
      package demo;

      @JsonTypeInfo(use = Id.DEDUCTION)
      public class DeductiveDto {
          public String id;
      }
    `;

    const host = new JavaSealedCompilerHost({
      trackedFiles: ['demo/Deductive.java'],
      readTextFile: () => source,
    });
    const engine = new JavaWireModelEngine(host);

    const result = engine.extractWireType('demo.DeductiveDto');
    expect(result.blockers.some(b =>
      b.code === 'UNRESOLVED_JACKSON_DEDUCTION' &&
      b.message === 'Jackson deduction cannot be verified statically'
    )).toBe(true);
  });

  it('emits UNRESOLVED_JACKSON_DEDUCTION for child class when parent interface uses Id.DEDUCTION', () => {
    const source = `
      package demo;

      @JsonTypeInfo(use = JsonTypeInfo.Id.DEDUCTION)
      public interface ParentDto {
      }

      public class ChildDto implements ParentDto {
          public String name;
      }
    `;

    const host = new JavaSealedCompilerHost({
      trackedFiles: ['demo/ParentChild.java'],
      readTextFile: () => source,
    });
    const engine = new JavaWireModelEngine(host);

    const result = engine.extractWireType('demo.ChildDto');
    expect(result.blockers.some(b =>
      b.code === 'UNRESOLVED_JACKSON_DEDUCTION' &&
      b.message === 'Jackson deduction cannot be verified statically'
    )).toBe(true);
  });

  it('maps class to single parameter wire type for @JsonCreator(mode = Mode.DELEGATING)', () => {
    const source = `
      package demo;

      public class DelegatingDto {
          private final String value;

          @JsonCreator(mode = Mode.DELEGATING)
          public DelegatingDto(String value) {
              this.value = value;
          }

          public String getValue() { return value; }
      }
    `;

    const host = new JavaSealedCompilerHost({
      trackedFiles: ['demo/DelegatingDto.java'],
      readTextFile: () => source,
    });
    const engine = new JavaWireModelEngine(host);

    const result = engine.extractWireType('demo.DelegatingDto');
    expect(result.blockers).toEqual([]);
    expect(result.wireType).toMatchObject({
      kind: 'PRIMITIVE',
      scalar: 'string',
    });
  });

  it('implicitly treats single-parameter creator without @JsonProperty as delegating mode', () => {
    const source = `
      package demo;

      public class UserId {
          private final Long id;

          @JsonCreator
          public UserId(Long id) {
              this.id = id;
          }

          public Long getId() { return id; }
      }
    `;

    const host = new JavaSealedCompilerHost({
      trackedFiles: ['demo/UserId.java'],
      readTextFile: () => source,
    });
    const engine = new JavaWireModelEngine(host);

    const result = engine.extractWireType('demo.UserId');
    expect(result.blockers).toEqual([]);
    expect(result.wireType).toMatchObject({
      kind: 'PRIMITIVE',
      scalar: 'number',
    });
  });

  it('correctly resolves properties for @JsonCreator(mode = Mode.PROPERTIES) with @JsonProperty', () => {
    const source = `
      package demo;

      public class PropertiesDto {
          private final String username;
          private final int userAge;

          @JsonCreator(mode = Mode.PROPERTIES)
          public PropertiesDto(
              @JsonProperty("user_name") String username,
              @JsonProperty("user_age") int userAge
          ) {
              this.username = username;
              this.userAge = userAge;
          }

          public String getUsername() { return username; }
          public int getUserAge() { return userAge; }
      }
    `;

    const host = new JavaSealedCompilerHost({
      trackedFiles: ['demo/PropertiesDto.java'],
      readTextFile: () => source,
    });
    const engine = new JavaWireModelEngine(host);

    const result = engine.extractWireType('demo.PropertiesDto');
    expect(result.blockers).toEqual([]);
    expect(result.wireType.kind).toBe('OBJECT');

    const obj = result.wireType as ObjectWireType;
    expect(obj.properties).toHaveLength(2);

    const usernameProp = obj.properties.find(p => p.wireName === 'user_name');
    expect(usernameProp).toBeDefined();
    expect(usernameProp).toMatchObject({
      wireName: 'user_name',
      type: {
        kind: 'PRIMITIVE',
        scalar: 'string',
      },
    });

    const ageProp = obj.properties.find(p => p.wireName === 'user_age');
    expect(ageProp).toBeDefined();
    expect(ageProp).toMatchObject({
      wireName: 'user_age',
      type: {
        kind: 'PRIMITIVE',
        scalar: 'number',
      },
    });
  });

  it('emits UNRESOLVED_JACKSON_CREATOR_PARAMETER_NAMES when parameters lack @JsonProperty', () => {
    const source = `
      package demo;

      public class MissingParamNamesDto {
          private final String firstName;
          private final String lastName;

          @JsonCreator(mode = Mode.PROPERTIES)
          public MissingParamNamesDto(String firstName, String lastName) {
              this.firstName = firstName;
              this.lastName = lastName;
          }
      }
    `;

    const host = new JavaSealedCompilerHost({
      trackedFiles: ['demo/MissingParamNamesDto.java'],
      readTextFile: () => source,
    });
    const engine = new JavaWireModelEngine(host);

    const result = engine.extractWireType('demo.MissingParamNamesDto');
    expect(result.blockers.some(b =>
      b.code === 'UNRESOLVED_JACKSON_CREATOR_PARAMETER_NAMES' &&
      b.message === 'Creator parameter names require @JsonProperty or compiled -parameters metadata'
    )).toBe(true);
  });

  it('emits UNRESOLVED_JACKSON_CREATOR_PARAMETER_NAMES for multi-param @JsonCreator without @JsonProperty', () => {
    const source = `
      package demo;

      public class MultiParamImplicitDto {
          @JsonCreator
          public MultiParamImplicitDto(String a, int b) {
          }
      }
    `;

    const host = new JavaSealedCompilerHost({
      trackedFiles: ['demo/MultiParamImplicitDto.java'],
      readTextFile: () => source,
    });
    const engine = new JavaWireModelEngine(host);

    const result = engine.extractWireType('demo.MultiParamImplicitDto');
    expect(result.blockers.some(b =>
      b.code === 'UNRESOLVED_JACKSON_CREATOR_PARAMETER_NAMES' &&
      b.message === 'Creator parameter names require @JsonProperty or compiled -parameters metadata'
    )).toBe(true);
  });
});
