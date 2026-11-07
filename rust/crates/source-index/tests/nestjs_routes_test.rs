use contract_core::envelope::{ArtifactPayload, BackendContractPayload, ContractArtifactEnvelope};
use contract_core::ir::{ContractDirection, EndpointContract, WireType};
use source_index::nestjs_routes::NestJsRouteExtractor;
use source_index::provider::ProviderKind;
use source_index::revision::BackendScope;
use std::fs;
use std::path::Path;
use tempfile::tempdir;

const MAIN_TS: &str = r#"
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  await app.listen(3000);
}
bootstrap();
"#;

const DTO_TS: &str = r#"
export interface CreateArticleDto {
  title: string;
  description: string;
  body: string;
  tagList?: string[];
}

export interface CreateCommentDto {
  body: string;
}
"#;

const INTERFACE_TS: &str = r#"
export interface ArticleRO {
  article: ArticleEntity;
}

export interface ArticlesRO {
  articles: ArticleEntity[];
  articlesCount: number;
}

export interface ArticleEntity {
  slug: string;
  title: string;
  author: UserEntity;
}

export interface UserEntity {
  username: string;
  articles: ArticleEntity[];
}
"#;

const CONTROLLER_TS: &str = r#"
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CreateArticleDto, CreateCommentDto } from './dto';
import { ArticleRO, ArticlesRO } from './article.interface';

export interface QueryDto {
  tag?: string;
  limit?: number;
}

@Controller('articles')
export class ArticleController {
  @Get()
  findAll(@Query() query: QueryDto): Promise<ArticlesRO> {
    return null as any;
  }

  @Get(['feed', 'latest'])
  feed(): ArticlesRO {
    return null as any;
  }

  @Get(':slug')
  findOne(@Param('slug') slug: string): Promise<ArticleRO> {
    return null as any;
  }

  @Post()
  create(@Body() body: CreateArticleDto): Promise<ArticleRO> {
    return null as any;
  }

  @Post(':slug/comments')
  comment(
    @Param('slug') slug: string,
    @Body('comment') body: CreateCommentDto,
  ): Promise<ArticleRO> {
    return null as any;
  }

  @Get('untyped')
  untyped(@Query() query) {
    return 'ok';
  }
}
"#;

fn fixture() -> tempfile::TempDir {
    let dir = tempdir().expect("tempdir");
    let src = dir.path().join("src");
    fs::create_dir_all(&src).expect("create src");
    fs::write(src.join("main.ts"), MAIN_TS).expect("main");
    fs::write(src.join("dto.ts"), DTO_TS).expect("dto");
    fs::write(src.join("article.interface.ts"), INTERFACE_TS).expect("interface");
    fs::write(src.join("article.controller.ts"), CONTROLLER_TS).expect("controller");
    dir
}

fn build(repo_root: &Path) -> ContractArtifactEnvelope {
    let extractor = NestJsRouteExtractor::new(repo_root.to_path_buf(), &repo_root.join("src"))
        .expect("extractor");
    extractor
        .build_envelope("articles", None, "HEAD")
        .expect("envelope")
}

fn backend(envelope: &ContractArtifactEnvelope) -> &BackendContractPayload {
    match &envelope.payload {
        ArtifactPayload::Backend(payload) => payload,
        ArtifactPayload::Frontend(_) => panic!("expected backend payload"),
    }
}

fn endpoint<'a>(
    payload: &'a BackendContractPayload,
    direction: ContractDirection,
    method: &str,
    path: &str,
) -> &'a EndpointContract {
    payload
        .endpoints
        .iter()
        .find(|endpoint| {
            endpoint.identity.direction == direction
                && endpoint.identity.http_method == method
                && endpoint.identity.normalized_route.raw_path == path
        })
        .unwrap_or_else(|| {
            let routes: Vec<String> = payload
                .endpoints
                .iter()
                .map(|e| {
                    format!(
                        "{} {:?} {}",
                        e.identity.http_method,
                        e.identity.direction,
                        e.identity.normalized_route.raw_path
                    )
                })
                .collect();
            panic!("missing {method} {path} {direction:?}; extracted: {routes:#?}")
        })
}

fn object_properties(wire: &WireType) -> Vec<(String, WireType)> {
    match wire {
        WireType::Object(object) => object
            .properties
            .iter()
            .map(|property| (property.wire_name.clone(), property.r#type.clone()))
            .collect(),
        other => panic!("expected an object body, got {other:?}"),
    }
}

#[test]
fn test_routes_carry_global_prefix_and_controller_prefix() {
    let dir = fixture();
    let envelope = build(dir.path());
    let payload = backend(&envelope);

    let routes: Vec<(String, String)> = payload
        .endpoints
        .iter()
        .map(|endpoint| {
            (
                endpoint.identity.http_method.clone(),
                endpoint.identity.normalized_route.raw_path.clone(),
            )
        })
        .collect();

    for expected in [
        ("GET", "/api/articles"),
        ("GET", "/api/articles/feed"),
        ("GET", "/api/articles/latest"),
        ("GET", "/api/articles/:slug"),
        ("POST", "/api/articles"),
        ("POST", "/api/articles/:slug/comments"),
        ("GET", "/api/articles/untyped"),
    ] {
        assert!(
            routes
                .iter()
                .any(|(method, path)| method == expected.0 && path == expected.1),
            "missing {expected:?} in {routes:#?}"
        );
    }
    // The array form of the route decorator expands into one route per literal.
    assert_eq!(
        routes
            .iter()
            .filter(|(method, path)| method == "GET" && path.starts_with("/api/articles/feed"))
            .count(),
        1
    );
}

#[test]
fn test_expectation_routes_are_response_and_request_contracts() {
    let dir = fixture();
    let envelope = build(dir.path());
    let payload = backend(&envelope);

    // Path parameters come from the route itself.
    let response = endpoint(
        payload,
        ContractDirection::Response,
        "GET",
        "/api/articles/:slug",
    );
    assert_eq!(response.path_parameters.len(), 1);
    assert_eq!(response.path_parameters[0].name, "slug");
    assert!(matches!(
        response.path_parameters[0].r#type,
        WireType::Primitive(_)
    ));
    assert!(matches!(response.body, Some(WireType::Ref(_))));

    // A typed `@Query()` DTO becomes one query parameter per property.
    let find_all = endpoint(payload, ContractDirection::Response, "GET", "/api/articles");
    let query: Vec<&str> = find_all
        .query_parameters
        .iter()
        .map(|param| param.name.as_str())
        .collect();
    assert_eq!(query, vec!["tag", "limit"], "query params: {query:?}");

    // `@Body('comment')` nests the DTO under the literal key the handler reads.
    let request = endpoint(
        payload,
        ContractDirection::Request,
        "POST",
        "/api/articles/:slug/comments",
    );
    let body = request.body.as_ref().expect("request body");
    let properties = object_properties(body);
    assert_eq!(properties.len(), 1);
    assert_eq!(properties[0].0, "comment");
    assert!(matches!(properties[0].1, WireType::Ref(_)));

    // A handler without a return annotation declares no response shape.
    let untyped = endpoint(
        payload,
        ContractDirection::Response,
        "GET",
        "/api/articles/untyped",
    );
    assert!(
        matches!(
            untyped.body,
            Some(WireType::Primitive(ref primitive))
                if primitive.scalar == contract_core::ir::PrimitiveScalar::Any
        ),
        "untyped return must be Any, got {:?}",
        untyped.body
    );
}

#[test]
fn test_dto_shapes_are_in_the_type_pool() {
    let dir = fixture();
    let mut envelope = build(dir.path());
    let payload = backend(&envelope);
    let pool = payload.type_pool.as_ref().expect("type pool");
    assert!(
        pool.contains_key("ts:src/dto.ts#CreateArticleDto"),
        "pool keys: {:?}",
        pool.keys().collect::<Vec<_>>()
    );

    contract_core::expansion::expand_type_pool(&mut envelope).expect("expand");
    let payload = backend(&envelope);

    let request = endpoint(payload, ContractDirection::Request, "POST", "/api/articles");
    let properties = object_properties(request.body.as_ref().expect("body"));
    let names: Vec<&str> = properties.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
        names,
        vec!["title", "description", "body", "tagList"],
        "expanded DTO: {properties:?}"
    );
    let tag_list = properties
        .iter()
        .find(|(name, _)| name == "tagList")
        .map(|(_, wire)| wire)
        .unwrap();
    let is_string_array = match tag_list {
        WireType::Array(_) => true,
        WireType::Optional(optional) => matches!(optional.inner_type.as_ref(), WireType::Array(_)),
        _ => false,
    };
    assert!(
        is_string_array,
        "tagList must stay an array, got {tag_list:?}"
    );
}

#[test]
fn test_untyped_bindings_and_template_routes_are_recorded_as_blockers() {
    let dir = tempdir().expect("tempdir");
    let src = dir.path().join("src");
    fs::create_dir_all(&src).expect("create src");
    fs::write(
        src.join("broken.controller.ts"),
        r#"
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

@Controller('things')
export class ThingsController {
  @Get()
  list(@Query() query) {
    return [];
  }

  @Post()
  create(@Body() body) {
    return {};
  }

  @Get(`:id/${this.template}`)
  bySlug(@Param('id') id) {
    return {};
  }
}
"#,
    )
    .expect("write controller");

    let envelope = build(dir.path());
    let codes: Vec<&str> = envelope
        .completeness
        .blockers
        .iter()
        .map(|blocker| blocker.code.as_str())
        .collect();

    for expected in [
        "NESTJS_QUERY_SHAPE_UNRESOLVED",
        "NESTJS_REQUEST_BODY_UNRESOLVED",
        "NESTJS_ROUTE_PATH_UNRESOLVED",
    ] {
        assert!(codes.contains(&expected), "missing {expected}: {codes:?}");
    }
    assert!(!envelope.completeness.complete);
    // The template route is anchored at its controller prefix, not dropped.
    let payload = backend(&envelope);
    assert!(payload
        .endpoints
        .iter()
        .any(|endpoint| endpoint.identity.normalized_route.raw_path == "/things"));
}

#[test]
fn test_foreign_controller_decorator_is_not_a_nest_controller() {
    let dir = tempdir().expect("tempdir");
    let src = dir.path().join("src");
    fs::create_dir_all(&src).expect("create src");
    fs::write(
        src.join("not-nest.controller.ts"),
        r#"
import { Controller } from 'some-other-framework';

@Controller('things')
export class ThingController {
  findAll() {
    return [];
  }
}
"#,
    )
    .expect("write controller");

    let extractor = NestJsRouteExtractor::new(dir.path().to_path_buf(), &src).expect("extractor");
    assert_eq!(
        extractor.controller_count(),
        0,
        "a `Controller` from another package must not be extracted"
    );
}

#[test]
fn test_recursive_interfaces_terminate_in_an_unknown_reference() {
    let dir = tempdir().expect("tempdir");
    let src = dir.path().join("src");
    fs::create_dir_all(&src).expect("create src");
    fs::write(
        src.join("node.controller.ts"),
        r#"
import { Controller, Get } from '@nestjs/common';
import { Node } from './node.interface';

@Controller('tree')
export class TreeController {
  @Get()
  root(): Node {
    return null as any;
  }
}
"#,
    )
    .expect("write controller");
    fs::write(
        src.join("node.interface.ts"),
        r#"
export interface Node {
  id: string;
  children: Node[];
}
"#,
    )
    .expect("write interface");

    let mut envelope = build(dir.path());
    contract_core::expansion::expand_type_pool(&mut envelope).expect("expansion terminates");

    let payload = backend(&envelope);
    let response = endpoint(payload, ContractDirection::Response, "GET", "/tree");
    let properties = object_properties(response.body.as_ref().expect("body"));
    let children = properties
        .iter()
        .find(|(name, _)| name == "children")
        .map(|(_, wire)| wire)
        .expect("children");
    let WireType::Array(array) = children else {
        panic!("children must be an array, got {children:?}");
    };
    let WireType::Unknown(unknown) = array.element_type.as_ref() else {
        panic!(
            "recursive element must abstain, got {:?}",
            array.element_type
        );
    };
    assert!(
        unknown.reason.contains("Recursive reference"),
        "reason: {}",
        unknown.reason
    );
}

#[test]
fn test_building_twice_is_byte_identical() {
    let dir = fixture();
    let first = build(dir.path());
    let second = build(dir.path());
    let first = serde_json::to_string(&first).expect("serialize");
    let second = serde_json::to_string(&second).expect("serialize");
    assert_eq!(first, second, "contract extraction must be deterministic");
}

#[test]
fn test_provider_detection_prefers_java_on_disk() {
    let java = tempdir().expect("tempdir");
    fs::create_dir_all(java.path().join("src/main/java/com/example")).expect("java dir");
    fs::write(
        java.path().join("src/main/java/com/example/App.java"),
        "package com.example; class App {}",
    )
    .expect("java file");
    assert_eq!(
        ProviderKind::detect_on_disk(java.path()),
        ProviderKind::Spring
    );

    let nest = tempdir().expect("tempdir");
    fs::create_dir_all(nest.path().join("src")).expect("src");
    fs::write(nest.path().join("src/app.controller.ts"), CONTROLLER_TS).expect("controller");
    assert_eq!(
        ProviderKind::detect_on_disk(nest.path()),
        ProviderKind::NestJs
    );

    // A module that carries Java sources stays on the Spring lane even when it
    // also contains a TypeScript controller.
    fs::create_dir_all(nest.path().join("src/main/java")).expect("java dir");
    fs::write(
        nest.path().join("src/main/java/Extra.java"),
        "class Extra {}",
    )
    .expect("java file");
    assert_eq!(
        ProviderKind::detect_on_disk(nest.path()),
        ProviderKind::Spring
    );
}

#[test]
fn test_provider_detection_from_a_revision_listing() {
    let dir = tempdir().expect("tempdir");
    let backend = BackendScope::new(dir.path(), "backend");

    let nest_paths = vec![
        "backend/src/app.module.ts".to_string(),
        "backend/src/article.controller.ts".to_string(),
    ];
    assert_eq!(
        ProviderKind::detect_in_listing(&backend, nest_paths.iter()),
        ProviderKind::NestJs
    );

    let java_paths = vec![
        "backend/src/App.java".to_string(),
        "backend/src/article.controller.ts".to_string(),
    ];
    assert_eq!(
        ProviderKind::detect_in_listing(&backend, java_paths.iter()),
        ProviderKind::Spring
    );

    // No controller file: the legacy Spring default, which is how every
    // repository behaved before the NestJS lane existed.
    let unrelated = vec!["README.md".to_string()];
    assert_eq!(
        ProviderKind::detect_in_listing(&backend, unrelated.iter()),
        ProviderKind::Spring
    );
}
