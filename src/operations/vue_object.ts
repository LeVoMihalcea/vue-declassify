import { Block, ClassDeclaration, Expression, GetAccessorDeclaration, JSDoc, ParameterDeclaration, printNode, PropertyAssignment, PropertyDeclaration, SetAccessorDeclaration, SourceFile, SyntaxKind, ts, TypeNode } from 'ts-morph'

import * as vue_class from './vue_class'
import * as imports from './imports'

const f = ts.factory

// Unclear how to directly plop an entire, pre-rendered comment in front.
// Forced to re-process the comment line-by-line to work with MultiLineCommentTriva.
function createDocumentation<T extends ts.Node>(target: T, docs: JSDoc[]) {
  if (docs.length > 0) {
    const comment = docs[0].compilerNode.comment

    if (comment) {
      return ts.addSyntheticLeadingComment(
        target, 
        SyntaxKind.MultiLineCommentTrivia, 
        '*\n' + // Starts with '/*'
          comment
            .split('\n')
            .map(line => ` * ${line}`)
            .join('\n')
        + '\n ', // Ends with '*/' 
        true,
      )
    }
  }

  return target
}

// Just passing the block compiler node makes it leave out all the values.
// No idea what I'm doing wrong, but... hey, it works if you re-render everything
// using getText()!
function transformBlock(block: Block, multiline?: boolean): ts.Block {
  return f.createBlock(
    [
      ...block
        .getStatementsWithComments()
        .map(statement => f.createExpressionStatement(
          f.createIdentifier(statement.getText()),
        )),
    ],
    true,
  )
}

function classNameToPropName(
  source: SourceFile,
  vue: {
    declaration: ClassDeclaration,
  }
): ts.PropertyAssignment {
  return f.createPropertyAssignment(
    f.createIdentifier('name'),
    f.createStringLiteral(vue.declaration.getNameOrThrow(), true),
  )
}

function classPropTypeToObjectPropType(
  source: SourceFile,
  prop: {
    declaration: PropertyDeclaration
  }
): ts.PropertyAssignment {
  let initializer: ts.Expression
  const type = prop.declaration.getType()

  if (type.isString()) {
    initializer = f.createIdentifier('String')

  } else if (type.isNumber()) {
    initializer = f.createIdentifier('Number')
  
  } else if (type.isBoolean()) {
    initializer = f.createIdentifier('Boolean')

  } else {
    imports.ensure(source, 'vue', {
      named: ['PropType'],
    })

    const type = prop.declaration.getType()
    const actualType = prop.declaration.getTypeNodeOrThrow().getText()

    // Vue.js props can only be primitive types, unless you use PropType.
    // However, even when using PropType, the base annotated type must be
    // the same type as the annotated one, or you get type errors anyway.
    let baseType: 'Object' | 'Function' | 'Array'

    // HACK: Adjust Object/Function/Array based on what the type seems to be.
    // This heuristic can be improved drastically, and is part of what makes
    // a project like vue-declassify difficult. 
    
    if (type.getCallSignatures().length > 0) {

      // This one is actually pretty safe. TS will tell us if what's inside has
      // a call signature, making it a function.
      baseType = 'Function'

    } else if (actualType.startsWith('Array<') || actualType.endsWith('[]')) {

      // This is some nonsense calculation but, it's quite effective? Arrays
      // are easy to spot syntactically. This doesn't work for user-defined
      // array types though. Fortunately, those are exceedingly rare.
      baseType = 'Array'

    } else {
      baseType = 'Object'
    }

    // HACK: Create a more concise `as` expression manually.
    initializer = f.createIdentifier(`${baseType} as PropType<${actualType}>`)
  }

  return f.createPropertyAssignment(
    f.createIdentifier('type'),
    initializer,
  )
}

function classPropOptionsToObjectPropOptions(
  source: SourceFile,
  prop: {
    default?: PropertyAssignment
    required?: PropertyAssignment
  }
): ts.PropertyAssignment[] {
  
  // Only permit exactly one of `default` and `required`,
  // since a default value implies required is false in Vue.
  // There actually doesn't seem to be a use-case to set both!
  if (prop.default) {
    
    // Note: I really want to just pass the compiler node, but
    // for some reason `default` is special and does not render.
    // Probably has to do with `default` being a TS keyword.
    return [
      f.createPropertyAssignment(
        f.createIdentifier('default'),
        f.createIdentifier(prop.default.getInitializerOrThrow().getText()),
      )
    ]

  } else if (prop.required) {
    return [prop.required.compilerNode]

  } else {

    // Lastly, if neither property is directly supplied, mark `required` false.
    // This is consistent with the vue-property-decorator defaults.
    return [
      f.createPropertyAssignment(
        f.createIdentifier('required'),
        f.createFalse(),
      )
    ]
  }
}

function classPropToObjectProp(
  source: SourceFile,
  prop: {
    declaration: PropertyDeclaration
    default?: PropertyAssignment
    required?: PropertyAssignment
  }
): ts.PropertyAssignment {
  return createDocumentation(
    f.createPropertyAssignment(
      f.createIdentifier(prop.declaration.getName()),
      f.createObjectLiteralExpression(
        [
          classPropTypeToObjectPropType(source, prop),
          ...classPropOptionsToObjectPropOptions(source, prop),
        ],
        true,
      ),
    ),
    prop.declaration.getJsDocs(),
  )
}

function classPropsToObjectProps(
  source: SourceFile,
  vue: {
    props: {
      declaration: PropertyDeclaration
      default?: PropertyAssignment
      required?: PropertyAssignment
    }[]
  }
): ts.PropertyAssignment {
  return f.createPropertyAssignment(
    f.createIdentifier('props'),
    f.createObjectLiteralExpression(
      vue.props.map(prop => classPropToObjectProp(source, prop)),
      true,
    ),
  )
}


function classDataToObjectData(
  source: SourceFile,
  vue: {
    data: PropertyDeclaration[],
  },
): ts.MethodDeclaration {
  const properties: ts.ObjectLiteralElementLike[] = []

  for (const declaration of vue.data) {
    const value = declaration.getInitializerOrThrow()
    const type = declaration.getTypeNode()

    // By default, initialize the data with whatever was on the other side of the declaration.
    let initializer: ts.Expression = f.createIdentifier(value.getText())

    // If there was a type declaration, port it to an `as` expression.
    if (type) {
      initializer = f.createIdentifier(`${value.getText()} as ${type.getText()}`)
    }

    properties.push(
      createDocumentation(
        f.createPropertyAssignment(
          declaration.getName(),
          initializer,
        ),
        declaration.getJsDocs(),
      )
    )
  }
  
  return f.createMethodDeclaration(
    undefined,
    undefined,
    undefined,
    f.createIdentifier('data'),
    undefined,
    undefined,
    [],
    undefined,
    f.createBlock(
      [
        f.createReturnStatement(
          f.createObjectLiteralExpression(
            properties,
            true,
          )
        ),
      ],
      true,
    )
  )
}

function classComputedGetterToObjectComputedGetter(
  source: SourceFile,
  name: string,
  getter: GetAccessorDeclaration,
): ts.MethodDeclaration {
  let getterReturnType: ts.TypeNode | undefined = undefined

  if (getter.getReturnTypeNode()) {
    getterReturnType = getter.getReturnTypeNodeOrThrow().compilerNode
  
  } else {
    getterReturnType = f.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)
    console.log(`Computed getter 「${name}」 will require a manual return type.`)
  }

  return f.createMethodDeclaration(
    undefined,
    undefined,
    undefined,
    f.createIdentifier(name),
    undefined,
    undefined,
    [],
    getterReturnType,
    transformBlock(getter.getBodyOrThrow() as Block, true),
  )
}

function classComputedPropertyToObjectComputedProperty(
  source: SourceFile,
  name: string,
  getter: GetAccessorDeclaration,
  setter: SetAccessorDeclaration,
): ts.PropertyAssignment {
  const setParameter = setter.getParameters()[0]

  if (!setParameter) {
    throw new Error('Computed setter doesn\'t seem to have a parameter.')
  }

  const setterDeclaration = f.createMethodDeclaration(
    undefined,
    undefined,
    undefined,
    f.createIdentifier('set'),
    undefined,
    undefined,
    [setParameter.compilerNode],
    undefined,
    transformBlock(setter.getBodyOrThrow() as Block, true),
  )

  let getterReturnType: ts.TypeNode | undefined = undefined

  // If there was a computed setter, Vue requires that the getter have
  // an annotated return type of the same type argument as that setter's
  // parameter. This is where we try to ensure that.
  if (setParameter.getTypeNode()) {
    getterReturnType = setParameter.getTypeNodeOrThrow().compilerNode

  } else {
    getterReturnType = f.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)
    console.log(`Computed getter for 「${name}」 will require a manual return type.`)
  }

  const getterDeclaration = f.createMethodDeclaration(
    undefined,
    undefined,
    undefined,
    f.createIdentifier('get'),
    undefined,
    undefined,
    [],
    getterReturnType,
    transformBlock(getter.getBodyOrThrow() as Block),
  )
      
  return f.createPropertyAssignment(
    f.createIdentifier(name),
    f.createObjectLiteralExpression(
      [
        getterDeclaration,
        setterDeclaration,
      ], 
      true,
    ),
  )
}

function classComputedToObjectComputed(
  source: SourceFile,
  vue: {
    computed: Record<string, {
      getter?: GetAccessorDeclaration
      setter?: SetAccessorDeclaration
    }>
  }
): ts.PropertyAssignment {
  const properties: ts.ObjectLiteralElementLike[] = []

  for (let [name, { getter, setter }] of Object.entries(vue.computed)) {
    if (getter) {
      if (setter) {
        properties.push(
          classComputedPropertyToObjectComputedProperty(
            source,
            name, 
            getter, 
            setter,
          ),
        )

      } else {
        properties.push(
          classComputedGetterToObjectComputedGetter(
            source, 
            name, 
            getter,
          ),
        )
      }

    } else if (setter) {
      throw new Error('Found an illegal computed setter without a getter.')
    }
  }

  return f.createPropertyAssignment(
    f.createIdentifier('computed'),
    f.createObjectLiteralExpression(properties, true),
  )
}

export function classToObject(source: SourceFile) {
  const vue = vue_class.extract(source)

  if (!vue) {
    return
  }

  const properties: ts.ObjectLiteralElementLike[] = []
  properties.push(classNameToPropName(source, vue))

  // Add any properties we inherited from the @Component decorator.
  // Note: this doesn't merge any Vue data that occurs in the class declaration.
  for (let property of vue.decorator.properties) {
    properties.push(property.compilerNode)
  }

  if (vue.props.length > 0) {
    properties.push(classPropsToObjectProps(source, vue))
  }

  if (vue.data.length > 0) {
    properties.push(classDataToObjectData(source, vue))
  }

  if (Object.keys(vue.computed).length > 0) {
    properties.push(classComputedToObjectComputed(source, vue))
  }

  // Wrap the properties up in a call to Vue.extend().
  const component = f.createCallExpression(
    f.createIdentifier('Vue.extend'),
    undefined,
    [f.createObjectLiteralExpression(properties, true)]
  )

  // Save the docs.
  let documentation: string

  if (vue.declaration.getJsDocs().length > 0) {
    documentation = vue.declaration.getJsDocs()[0].getFullText()
  }

  // Remove the class now that we're done reading everything.
  vue.declaration.remove()

  // Add the new default export statement, printing from the object AST.
  source.addExportAssignment({
    expression: printNode(component),
    isExportEquals: false,
    leadingTrivia: writer => {
      if (documentation) {
        writer.writeLine(documentation)
      }
    }
  })
    
  source.formatText()
}
